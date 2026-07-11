import { incidentQuerySchema } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";

function record(value: Prisma.JsonValue | null) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function incidentDto(row: Awaited<ReturnType<typeof prisma.opsIncident.findUniqueOrThrow>>) {
  const mitigation = record(row.mitigation);
  const impact = record(row.impact);
  const verification = record(mitigation.verification as Prisma.JsonValue | null);
  return {
    id: row.id,
    signature: row.signature,
    signatureVersion: row.signatureVersion,
    status: row.status,
    severity: row.severity,
    ownerId: row.ownerId,
    firstSeenAt: row.firstSeen.toISOString(),
    lastSeenAt: row.lastSeen.toISOString(),
    impact: {
      affectedRequests: Number(impact.affectedRequests ?? 0),
      affectedUsers: Number(impact.affectedUsers ?? 0),
      failedCostMicros: Number(impact.failedCostMicros ?? 0),
      refundMicros: Number(impact.refundMicros ?? 0),
      refundDreamcoins: Number(impact.refundDreamcoins ?? 0),
    },
    lastKnownGoodAt: typeof mitigation.lastKnownGoodAt === "string" ? mitigation.lastKnownGoodAt : null,
    slaDueAt: iso(row.slaDueAt),
    suspectedCause: row.suspectedCause,
    causeConfidence: row.confidence,
    recommendedActions: Array.isArray(mitigation.recommendedActions)
      ? mitigation.recommendedActions.filter((item): item is string => typeof item === "string")
      : [],
    runbookUrl: typeof mitigation.runbookUrl === "string" ? mitigation.runbookUrl : null,
    rollbackTarget: typeof mitigation.rollbackTarget === "string" ? mitigation.rollbackTarget : null,
    recoveryVerification: {
      state: row.verificationState,
      checkedAt: typeof verification.checkedAt === "string" ? verification.checkedAt : null,
      evidenceRefs: Array.isArray(verification.evidenceRefs)
        ? verification.evidenceRefs.filter((item): item is string => typeof item === "string")
        : [],
    },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listIncidents(request: Request) {
  const actor = await actorWithPermission(request, "ops.incident.read");
    const url = new URL(request.url);
    const query = incidentQuerySchema.parse(Object.fromEntries(url.searchParams));
    const where: Prisma.OpsIncidentWhereInput = {
      status: query.status,
      severity: query.severity,
      ownerId: query.ownerId,
      ...(actor.role === "support" ? { ownerId: actor.id } : {}),
      ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      ...(query.search
        ? {
            OR: [
              { signature: { contains: query.search, mode: "insensitive" } },
              { suspectedCause: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const rows = await prisma.opsIncident.findMany({
      where,
      orderBy: { id: "asc" },
      take: query.limit + 1,
    });
    const hasNextPage = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(incidentDto);
  return ok({
      items,
      pageInfo: { endCursor: hasNextPage ? items.at(-1)?.id ?? null : null, hasNextPage },
      asOf: new Date().toISOString(),
      freshness: "fresh",
  });
}

export async function getIncidentDetail(request: Request, incidentId: string) {
  const actor = await actorWithPermission(request, "ops.incident.read");
  const incident = await prisma.opsIncident.findUnique({ where: { id: incidentId } });
  if (!incident) throw Errors.notFound("Incident not found");
  if (actor.role === "support" && incident.ownerId !== actor.id) {
    throw Errors.forbidden("Incident is outside the actor's assigned scope");
  }
  const [occurrences, actionPlans, activity] = await Promise.all([
    prisma.opsIncidentOccurrence.findMany({
      where: { incidentId },
      orderBy: [{ observedAt: "desc" }, { id: "desc" }],
    }),
    prisma.incidentActionPlan.findMany({
      where: { incidentId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.adminAuditLog.findMany({
      where: { targetType: "ops_incident", targetId: incidentId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return ok({
    incident: incidentDto(incident),
    occurrences: occurrences.map((row) => ({
      id: row.id,
      incidentId: row.incidentId,
      requestId: row.requestId,
      attemptId: row.attemptId,
      transportExecutionId: row.transportExecutionId,
      observedAt: row.observedAt.toISOString(),
    })),
    actionPlans: actionPlans.map((row) => ({
      id: row.id,
      action: row.action,
      incidentVersion: row.incidentVersion,
      occurrenceSetHash: row.eligibleIdsHash,
      eligibleOccurrenceIds: row.eligibleIds,
      skippedOccurrenceIds: row.skippedIds,
      impact: row.impactSnapshot,
      targetVersion: row.targetVersion,
      expiresAt: row.expiresAt.toISOString(),
      createdBy: row.createdById,
      createdAt: row.createdAt.toISOString(),
    })),
    activity,
  });
}
