import { prisma } from "@/server/lib/db";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "../shared/prisma-json";
import { operationalContentProductionBatchWhere } from "@/server/modules/metric-data-scope";
import { jsonRecord } from "./json";

// SPEC: 把一轮 Creative Run 的失败 Attempt 挂到一个活跃 Incident 上。
// INTENT: 这条路径写的是 OpsIncident 聚合（occurrence + impact + version），Creative Run
// 侧只递增 version。它既不推进 Run 状态，也不碰素材权威。

export async function attachCreativeRunToIncident(input: {
  readonly runId: string;
  readonly incidentId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
      include: { items: { select: { jobId: true } } },
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before Incident attachment", { currentVersion: run.version });
    }
    const incident = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!incident || ["resolved", "closed"].includes(incident.status)) {
      throw Errors.conflict("Only an active Incident can receive Creative Run occurrences");
    }
    const requestIds = run.items.flatMap((item) => item.jobId ? [item.jobId] : []);
    const attempts = await tx.generationAttempt.findMany({
      where: { requestId: { in: requestIds }, status: { in: ["failed", "unknown"] } },
      orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
    });
    const latestAttempts = [...new Map(attempts.map((attempt) => [attempt.requestId, attempt])).values()];
    if (latestAttempts.length === 0) {
      throw Errors.conflict("Creative Run has no failed or unknown Attempt to attach");
    }
    const existing = await tx.opsIncidentOccurrence.findMany({
      where: { attemptId: { in: latestAttempts.map((attempt) => attempt.id) } },
    });
    const conflicting = existing.find((occurrence) => occurrence.incidentId !== incident.id);
    if (conflicting) {
      throw Errors.conflict("A Creative failure already belongs to another Incident", {
        occurrenceId: conflicting.id,
        incidentId: conflicting.incidentId,
        deepLink: `/admin/ops/incidents/${conflicting.incidentId}`,
      });
    }
    const attachedAttemptIds = new Set(existing.map((occurrence) => occurrence.attemptId));
    const toCreate = latestAttempts.filter((attempt) => !attachedAttemptIds.has(attempt.id));
    if (toCreate.length > 0) {
      await tx.opsIncidentOccurrence.createMany({
        data: toCreate.map((attempt) => ({
          incidentId: incident.id,
          requestId: attempt.requestId,
          attemptId: attempt.id,
          occurrenceKey: `creative_manual:${run.id}:${attempt.id}`,
          observedAt: attempt.finishedAt ?? attempt.createdAt,
        })),
      });
    }
    const now = new Date();
    const impact = jsonRecord(incident.impact);
    const creativeRunIds = Array.isArray(impact.creativeRunIds)
      ? impact.creativeRunIds.filter((value): value is string => typeof value === "string")
      : [];
    const updatedIncident = await tx.opsIncident.update({
      where: { id: incident.id },
      data: {
        impact: toInputJson({ ...impact, creativeRunIds: [...new Set([...creativeRunIds, run.id])] }),
        lastSeen: now,
        version: { increment: 1 },
      },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id },
      data: { version: { increment: 1 } },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.run.incident_attached",
        targetType: "creative_run",
        targetId: run.id,
        reason: input.reason,
        after: toInputJson({
          incidentId: incident.id,
          occurrenceCount: latestAttempts.length,
          createdOccurrenceCount: toCreate.length,
          runVersion: updatedRun.version,
          incidentVersion: updatedIncident.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.run.incident_attached.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          incidentId: incident.id,
          attemptIds: latestAttempts.map((attempt) => attempt.id),
          runVersion: updatedRun.version,
          incidentVersion: updatedIncident.version,
        }),
      },
    });
    return {
      runId: run.id,
      incidentId: incident.id,
      relatedAttemptIds: latestAttempts.map((attempt) => attempt.id),
      runVersion: updatedRun.version,
      incidentVersion: updatedIncident.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}
