import { Prisma, type PrismaClient } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { recordGenerationAttemptQueuedEvent } from "@/server/ai/generation-attempt-events";
import { ensureGenerationSettlementLinks, linkGenerationLedgerEntry } from "@/server/ai/generation-settlement";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { transitionControlPlaneCommandAttempt } from "../shared/control-plane-command-attempt";
import { toInputJson } from "../shared/prisma-json";

function record(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function finishAttempt(
  tx: Prisma.TransactionClient,
  commandId: string,
  attemptNo: number,
  status: "succeeded" | "failed",
  result: Record<string, unknown>,
) {
  const now = new Date();
  await tx.controlPlaneCommand.update({
    where: { id: commandId },
    data: {
      status,
      result: toInputJson(result),
      error: status === "failed" ? toInputJson(result) : Prisma.DbNull,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      finishedAt: now,
    },
  });
  await transitionControlPlaneCommandAttempt(tx, {
    commandId,
    attemptNo,
    to: status,
    data: {
      error: status === "failed" ? toInputJson(result) : Prisma.DbNull,
      finishedAt: now,
    },
  });
}

async function failClaimedCommand(
  db: PrismaClient,
  input: { commandId: string; attemptNo: number; workerId: string; error: unknown },
) {
  const result = {
    code: "incident_action_execution_failed",
    message: input.error instanceof Error ? input.error.message : "Incident action execution failed",
  };
  await db.$transaction(async (tx) => {
    await tx.controlPlaneCommand.updateMany({
      where: { id: input.commandId, status: "running", leaseOwner: input.workerId },
      data: {
        status: "failed",
        error: toInputJson(result),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await transitionControlPlaneCommandAttempt(tx, {
      commandId: input.commandId,
      attemptNo: input.attemptNo,
      to: "failed",
      data: { error: toInputJson(result), finishedAt: new Date() },
    });
  });
}

async function appendRefund(
  tx: Prisma.TransactionClient,
  input: { commandId: string; jobId: string },
) {
  const job = await tx.generationJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw Errors.notFound("Incident refund target Generation Request is missing");
  await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${job.id} FOR UPDATE`;
  const settlement = await ensureGenerationSettlementLinks(tx, job.id);
  const amount = settlement.refundable;
  if (amount === 0) return { jobId: job.id, amount: 0, alreadySettled: true };
  const idempotencyKey = `incident:${input.commandId}:refund:${job.id}`;
  const existing = await tx.dreamcoinLedger.findUnique({ where: { idempotencyKey } });
  if (existing) return { jobId: job.id, amount: existing.delta, alreadySettled: true };
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${job.userId} FOR UPDATE`;
  const balance = await tx.dreamcoinLedger.aggregate({ where: { userId: job.userId }, _sum: { delta: true } });
  const refund = await tx.dreamcoinLedger.create({
    data: {
      userId: job.userId,
      delta: amount,
      balanceAfter: (balance._sum.delta ?? 0) + amount,
      reason: "refund",
      sourceId: job.id,
      idempotencyKey,
    },
  });
  await linkGenerationLedgerEntry(tx, refund);
  return { jobId: job.id, amount, alreadySettled: false };
}

export async function executeIncidentActionPlanCommand(
  db: PrismaClient,
  input: { readonly commandId: string; readonly workerId: string },
) {
  const existing = await db.controlPlaneCommand.findUnique({ where: { id: input.commandId } });
  if (!existing) throw Errors.notFound("Incident action command not found");
  if (existing.commandType !== "incident.action_plan.execute") {
    throw Errors.badRequest("Command is not an Incident action-plan command");
  }
  if (["succeeded", "failed", "cancelled", "verifying"].includes(existing.status)) return existing;
  const claimed = await claimControlPlaneCommand(db, {
    commandId: existing.id,
    workerId: input.workerId,
    leaseMs: 60_000,
  });
  if (!claimed) return db.controlPlaneCommand.findUniqueOrThrow({ where: { id: existing.id } });

  try {
    return await db.$transaction(async (tx) => {
      const plan = await tx.incidentActionPlan.findUnique({ where: { id: claimed.targetId } });
      if (!plan) throw Errors.notFound("Incident action plan disappeared during execution");
      const incident = await tx.opsIncident.findUnique({ where: { id: plan.incidentId } });
      if (!incident) throw Errors.notFound("Incident disappeared during action execution");
      if (plan.incidentVersion !== claimed.expectedVersion || incident.version !== claimed.expectedVersion + 1) {
        throw Errors.conflict("Incident or frozen action plan changed before execution");
      }
      const activePlan = record(incident.mitigation).activeActionPlan;
      if (!activePlan || typeof activePlan !== "object" || Array.isArray(activePlan) || record(activePlan as Prisma.JsonObject).commandId !== claimed.id) {
        throw Errors.conflict("Incident no longer points at this action command");
      }
      const eligibleIds = stringArray(plan.eligibleIds);
      const occurrences = await tx.opsIncidentOccurrence.findMany({
        where: { incidentId: incident.id, id: { in: eligibleIds } },
        orderBy: { id: "asc" },
      });
      if (occurrences.length !== eligibleIds.length) throw Errors.conflict("Frozen Incident occurrence set is incomplete");

      const result: Record<string, unknown> = { action: plan.action, eligibleOccurrenceIds: eligibleIds };
      if (plan.action === "retry_eligible") {
        const attemptIds: string[] = [];
        for (const occurrence of occurrences) {
          if (!occurrence.requestId) throw Errors.conflict("Retry occurrence has no Generation Request");
          const [job, latest] = await Promise.all([
            tx.generationJob.findUnique({ where: { id: occurrence.requestId } }),
            tx.generationAttempt.findFirst({ where: { requestId: occurrence.requestId }, orderBy: { attemptNo: "desc" } }),
          ]);
          if (!job || !latest || !["failed", "unknown"].includes(latest.status)) {
            throw Errors.conflict("Frozen retry target is no longer retryable", { occurrenceId: occurrence.id });
          }
          const attempt = await tx.generationAttempt.create({
            data: {
              requestId: job.id,
              attemptNo: latest.attemptNo + 1,
              provider: latest.provider ?? job.provider,
              profileKey: latest.profileKey ?? job.profileId,
              profileVersion: latest.profileVersion ?? job.profileVersion,
              workflowKey: latest.workflowKey ?? job.model,
              workflowVersion: latest.workflowVersion,
              status: "queued",
              sourceCommandId: claimed.id,
            },
          });
          await recordGenerationAttemptQueuedEvent(tx, attempt);
          await tx.generationJob.update({
            where: { id: job.id },
            data: { status: "queued", errorCode: null, completedAt: null, finishedAt: null, deliveredOutputCount: 0, version: { increment: 1 } },
          });
          await tx.mainOutboxEvent.upsert({
            where: { id: `incident_retry_${claimed.id}_${occurrence.id}` },
            create: {
              id: `incident_retry_${claimed.id}_${occurrence.id}`,
              eventType: "incident.retry.dispatch.v2",
              aggregateType: "ops_incident",
              aggregateId: incident.id,
              payload: toInputJson({
                incidentId: incident.id,
                actionPlanId: plan.id,
                occurrenceId: occurrence.id,
                generationJobId: job.id,
                attemptId: attempt.id,
                attemptNo: attempt.attemptNo,
                commandId: claimed.id,
              }),
            },
            update: {},
          });
          attemptIds.push(attempt.id);
        }
        result.attemptIds = attemptIds;
        await tx.controlPlaneCommand.update({
          where: { id: claimed.id },
          data: {
            status: "verifying",
            result: toInputJson({ ...result, executionState: "verifying" }),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: new Date(),
          },
        });
      } else if (plan.action === "refund") {
        const settlements = [];
        for (const occurrence of occurrences) {
          if (!occurrence.requestId) throw Errors.conflict("Refund occurrence has no Generation Request");
          settlements.push(await appendRefund(tx, { commandId: claimed.id, jobId: occurrence.requestId }));
        }
        result.settlements = settlements;
        await finishAttempt(tx, claimed.id, claimed.attemptCount, "succeeded", { ...result, executionState: "succeeded" });
      } else {
        const signature = record(incident.mitigation).signatureComponents;
        const components = signature && typeof signature === "object" && !Array.isArray(signature)
          ? signature as Record<string, unknown>
          : {};
        const profileKey = typeof components.profileKey === "string" ? components.profileKey : null;
        const provider = typeof components.provider === "string" ? components.provider : null;
        if (!profileKey) throw Errors.conflict("Incident lacks exact profile authority for route action");
        if (plan.action === "pause_route") {
          const paused = await tx.generationProviderRoute.updateMany({
            where: { profileKey, ...(provider ? { provider } : {}), enabled: true },
            data: { enabled: false },
          });
          if (paused.count === 0) throw Errors.conflict("No matching enabled provider route was found");
          result.pausedRoutes = paused.count;
        } else {
          const targetVersion = Number(plan.targetVersion);
          if (!Number.isInteger(targetVersion) || targetVersion <= 0) {
            throw Errors.badRequest("Rollback targetVersion must be a positive profile version");
          }
          const target = await tx.generationModelProfile.findFirst({ where: { profileKey, version: targetVersion } });
          if (!target || !target.enabled) throw Errors.conflict("Rollback target profile is unavailable");
          await tx.generationModelProfile.updateMany({
            where: { profileKey, status: "active", id: { not: target.id } },
            data: { status: "archived", archivedAt: new Date() },
          });
          await tx.generationModelProfile.update({
            where: { id: target.id },
            data: { status: "active", archivedAt: null, publishedAt: target.publishedAt ?? new Date() },
          });
          result.profileKey = profileKey;
          result.targetProfileId = target.id;
          result.targetVersion = target.version;
        }
        await finishAttempt(tx, claimed.id, claimed.attemptCount, "succeeded", { ...result, executionState: "succeeded" });
      }

      await tx.adminAuditLog.create({
        data: {
          actorId: claimed.actorId,
          actorRole: "command_executor",
          action: `incident.action_plan.${plan.action}.${plan.action === "retry_eligible" ? "started" : "completed"}`,
          targetType: "ops_incident",
          targetId: incident.id,
          reason: "Frozen Incident action plan executed by the durable command worker",
          after: toInputJson({ commandId: claimed.id, actionPlanId: plan.id, ...result }),
          requestId: claimed.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: `incident.action.${plan.action}.${plan.action === "retry_eligible" ? "started" : "completed"}.v2`,
          aggregateType: "ops_incident",
          aggregateId: incident.id,
          payload: toInputJson({ incidentId: incident.id, actionPlanId: plan.id, commandId: claimed.id, ...result }),
        },
      });
      return tx.controlPlaneCommand.findUniqueOrThrow({ where: { id: claimed.id } });
    });
  } catch (error) {
    await failClaimedCommand(db, {
      commandId: claimed.id,
      attemptNo: claimed.attemptCount,
      workerId: input.workerId,
      error,
    });
    throw error;
  }
}

export async function verifyIncidentActionPlanCommands(
  db: PrismaClient,
  input: { readonly limit?: number } = {},
) {
  const commands = await db.controlPlaneCommand.findMany({
    where: { commandType: "incident.action_plan.execute", status: "verifying" },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let pending = 0;
  let succeeded = 0;
  let failed = 0;
  for (const command of commands) {
    const attempts = await db.generationAttempt.findMany({ where: { sourceCommandId: command.id } });
    const terminal = attempts.length > 0 && attempts.every((attempt) => ["succeeded", "failed", "cancelled", "unknown"].includes(attempt.status));
    if (!terminal) {
      pending += 1;
      continue;
    }
    const passed = attempts.every((attempt) => attempt.status === "succeeded");
    await db.$transaction(async (tx) => {
      const result = { ...record(command.result), executionState: passed ? "succeeded" : "failed", attemptIds: attempts.map((attempt) => attempt.id) };
      await finishAttempt(tx, command.id, command.attemptCount, passed ? "succeeded" : "failed", result);
      await tx.adminAuditLog.create({
        data: {
          actorId: command.actorId,
          actorRole: "command_verifier",
          action: passed ? "incident.action_plan.retry_verified" : "incident.action_plan.retry_failed",
          targetType: "incident_action_plan",
          targetId: command.targetId,
          reason: passed ? "Every frozen retry attempt succeeded" : "At least one frozen retry attempt did not recover",
          after: toInputJson(result),
          requestId: command.requestId,
        },
      });
    });
    if (passed) succeeded += 1;
    else failed += 1;
  }
  return { examined: commands.length, pending, succeeded, failed };
}
