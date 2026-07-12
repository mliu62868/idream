import { Prisma, type PrismaClient } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { enqueueGenerationAttempt } from "@/server/modules/generation/attempt-dispatch";
import { recordGenerationAttemptQueuedEvent } from "@/server/ai/generation-attempt-events";
import { claimControlPlaneCommand } from "../shared/control-plane-command";
import { toInputJson } from "../shared/prisma-json";
import {
  isControlPlaneCommandTransitionAllowed,
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
} from "../shared/state-transition-authority";

const TERMINAL_ATTEMPT_STATES = new Set(["succeeded", "failed", "cancelled", "unknown"]);
const HEALTHY_VERIFICATION_STATES = new Set(["passed", "verified", "manual_passed"]);

function record(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function generationProfileHealth(profile: {
  enabled: boolean;
  status: string;
  runnerConfig: Prisma.JsonValue | null;
} | null) {
  if (!profile) return { healthy: false, reason: "generation_profile_missing" } as const;
  if (!profile.enabled || profile.status !== "active") {
    return { healthy: false, reason: "generation_profile_inactive" } as const;
  }
  const verificationState = record(profile.runnerConfig).verificationStatus;
  if (
    typeof verificationState === "string" &&
    !HEALTHY_VERIFICATION_STATES.has(verificationState)
  ) {
    return { healthy: false, reason: `generation_profile_${verificationState}` } as const;
  }
  return { healthy: true, reason: null } as const;
}

async function failCommand(
  db: PrismaClient,
  input: { commandId: string; attemptNo: number; workerId: string; error: unknown },
) {
  const error = {
    code: "creative_retry_execution_failed",
    message: input.error instanceof Error ? input.error.message : "Creative retry execution failed",
  };
  await db.$transaction(async (tx) => {
    await tx.controlPlaneCommand.updateMany({
      where: {
        id: input.commandId,
        status: "running",
        leaseOwner: input.workerId,
      },
      data: {
        status: "failed",
        error: toInputJson(error),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
    await tx.controlPlaneCommandAttempt.updateMany({
      where: { commandId: input.commandId, attemptNo: input.attemptNo, status: "running" },
      data: { status: "failed", error: toInputJson(error), finishedAt: new Date() },
    });
  });
}

export async function executeCreativeRetryCommand(
  db: PrismaClient,
  input: { readonly commandId: string; readonly workerId: string },
) {
  const existing = await db.controlPlaneCommand.findUnique({ where: { id: input.commandId } });
  if (!existing) throw Errors.notFound("Creative retry command not found");
  if (existing.commandType !== "creative.run.retry_failed") {
    throw Errors.badRequest("Command is not a Creative retry command");
  }
  if (["verifying", "succeeded", "failed", "cancelled"].includes(existing.status)) return existing;

  const claimed = await claimControlPlaneCommand(db, {
    commandId: input.commandId,
    workerId: input.workerId,
    leaseMs: 60_000,
  });
  if (!claimed) return db.controlPlaneCommand.findUniqueOrThrow({ where: { id: input.commandId } });

  try {
    return await db.$transaction(async (tx) => {
      const run = await tx.contentProductionBatch.findUnique({
        where: { id: claimed.targetId },
        include: {
          items: {
            include: { job: true },
          },
        },
      });
      if (!run) throw Errors.notFound("Creative Run not found during retry execution");
      if (run.version !== claimed.expectedVersion) {
        throw Errors.conflict("Creative Run changed before retry execution", {
          expectedVersion: claimed.expectedVersion,
          actualVersion: run.version,
        });
      }
      if (!isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, "active")) {
        throw Errors.conflict("Creative Run is not active for retry", { lifecycleState: run.lifecycleState });
      }
      const failedItemIds = stringArray(record(claimed.requestPayload).failedItemIds as Prisma.JsonValue);
      if (failedItemIds.length === 0) throw Errors.conflict("Retry command has no frozen failed-item set");
      const items = run.items.filter((item) => failedItemIds.includes(item.id));
      if (items.length !== failedItemIds.length) {
        throw Errors.conflict("Creative retry target set changed before execution");
      }

      const attemptIds: string[] = [];
      for (const item of items) {
        if (!isCreativeRunItemTransitionAllowed(item.status, "regenerate_requested") || !item.job) {
          throw Errors.conflict("Creative item is no longer retryable", { itemId: item.id });
        }
        const latest = await tx.generationAttempt.findFirst({
          where: { requestId: item.job.id },
          orderBy: { attemptNo: "desc" },
        });
        if (latest?.retryability === "not_retryable" || latest?.status === "unknown") {
          throw Errors.conflict("Generation attempt requires reconciliation and cannot be replayed", {
            itemId: item.id,
            attemptId: latest.id,
          });
        }
        const profile = await tx.generationModelProfile.findFirst({
          where: {
            version: item.job.profileVersion ?? run.profileVersion ?? undefined,
            OR: [
              ...(item.job.profileId ? [{ id: item.job.profileId }, { profileKey: item.job.profileId }] : []),
              ...(run.profileId ? [{ id: run.profileId }, { profileKey: run.profileId }] : []),
            ],
          },
          orderBy: { version: "desc" },
        });
        const health = generationProfileHealth(profile);
        if (!health.healthy) {
          throw Errors.conflict("Generation dependency is unhealthy; retry is disabled", {
            itemId: item.id,
            reason: health.reason,
          });
        }
        const attemptNo = (latest?.attemptNo ?? 0) + 1;
        const attempt = await tx.generationAttempt.upsert({
          where: {
            sourceCommandId_creativeRunItemId: {
              sourceCommandId: claimed.id,
              creativeRunItemId: item.id,
            },
          },
          create: {
            requestId: item.job.id,
            attemptNo,
            provider: item.job.provider,
            profileKey: item.job.profileId,
            profileVersion: item.job.profileVersion,
            status: "queued",
            sourceCommandId: claimed.id,
            creativeRunItemId: item.id,
          },
          update: {},
        });
        await recordGenerationAttemptQueuedEvent(tx, attempt);
        attemptIds.push(attempt.id);
        await tx.generationJob.update({
          where: { id: item.job.id },
          data: { status: "queued", errorCode: null, completedAt: null, finishedAt: null, deliveredOutputCount: 0, version: { increment: 1 } },
        });
        await tx.contentProductionItem.update({
          where: { id: item.id },
          data: { status: "regenerate_requested", version: { increment: 1 } },
        });
        await tx.mainOutboxEvent.upsert({
          where: { id: `creative_retry_${claimed.id}_${item.id}` },
          create: {
            id: `creative_retry_${claimed.id}_${item.id}`,
            eventType: "creative.retry.dispatch.v2",
            aggregateType: "creative_run",
            aggregateId: run.id,
            payload: toInputJson({
              commandId: claimed.id,
              runId: run.id,
              itemId: item.id,
              generationJobId: item.job.id,
              attemptId: attempt.id,
              attemptNo: attempt.attemptNo,
            }),
          },
          update: {},
        });
      }

      const updatedRun = await tx.contentProductionBatch.update({
        where: { id: run.id },
        data: {
          workflowStage: "generation",
          verificationState: "verifying",
          status: "queued",
          version: { increment: 1 },
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: claimed.actorId,
          actorRole: "command_executor",
          action: "creative.run.retry_started",
          targetType: "creative_run",
          targetId: run.id,
          reason: "Frozen eligible failed items were converted to new business attempts",
          before: toInputJson({ version: run.version, failedItemIds }),
          after: toInputJson({ version: updatedRun.version, attemptIds, verificationState: "verifying" }),
          requestId: claimed.requestId,
        },
      });
      if (!isControlPlaneCommandTransitionAllowed(claimed.status, "verifying")) {
        throw Errors.conflict("Creative retry command cannot enter verification", { status: claimed.status });
      }
      return tx.controlPlaneCommand.update({
        where: { id: claimed.id },
        data: {
          status: "verifying",
          result: toInputJson({
            runId: run.id,
            runVersion: updatedRun.version,
            itemIds: failedItemIds,
            attemptIds,
            verificationState: "verifying",
          }),
          heartbeatAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
    });
  } catch (error) {
    await failCommand(db, {
      commandId: claimed.id,
      attemptNo: claimed.attemptCount,
      workerId: input.workerId,
      error,
    });
    throw error;
  }
}

export async function dispatchCreativeRetryOutbox(
  db: PrismaClient,
  input: { readonly limit?: number; readonly outboxIds?: readonly string[] } = {},
) {
  const rows = await db.mainOutboxEvent.findMany({
    where: {
      eventType: { in: [
        "creative.retry.dispatch.v2",
        "creative.generation.dispatch.v2",
        "incident.retry.dispatch.v2",
        "generation.retry.dispatch.v2",
      ] },
      status: { in: ["pending", "dispatched"] },
      nextRunAt: { lte: new Date() },
      ...(input.outboxIds ? { id: { in: [...input.outboxIds] } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const payload = record(row.payload);
    const generationJobId = typeof payload.generationJobId === "string" ? payload.generationJobId : null;
    const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : null;
    const attemptNo = typeof payload.attemptNo === "number" ? payload.attemptNo : null;
    try {
      if (!generationJobId || !attemptId || !attemptNo) throw new Error("Creative generation outbox payload is invalid");
      const [job, attempt] = await Promise.all([
        db.generationJob.findUnique({ where: { id: generationJobId } }),
        db.generationAttempt.findUnique({ where: { id: attemptId } }),
      ]);
      if (!job || !attempt || attempt.attemptNo !== attemptNo) {
        throw new Error("Creative generation authority is missing");
      }
      await enqueueGenerationAttempt(job, { attemptId, attemptNo });
      await db.mainOutboxEvent.update({
        where: { id: row.id },
        data: { status: "delivered", attempts: { increment: 1 }, deliveredAt: new Date(), lastError: Prisma.DbNull },
      });
      delivered += 1;
    } catch (error) {
      await db.mainOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: "pending",
          attempts: { increment: 1 },
          nextRunAt: new Date(Date.now() + 30_000),
          lastError: toInputJson({ message: error instanceof Error ? error.message : "Creative generation dispatch failed" }),
        },
      });
      failed += 1;
    }
  }
  return { examined: rows.length, delivered, failed };
}

export async function verifyCreativeRetryCommands(
  db: PrismaClient,
  input: { readonly limit?: number } = {},
) {
  const commands = await db.controlPlaneCommand.findMany({
    where: { commandType: "creative.run.retry_failed", status: "verifying" },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const command of commands) {
    const attempts = await db.generationAttempt.findMany({
      where: { sourceCommandId: command.id },
      orderBy: { attemptNo: "asc" },
    });
    const items = await db.contentProductionItem.findMany({
      where: { id: { in: attempts.flatMap((attempt) => attempt.creativeRunItemId ? [attempt.creativeRunItemId] : []) } },
      include: { mediaAsset: true, job: { include: { assets: true } } },
    });
    const itemById = new Map(items.map((item) => [item.id, item]));
    const allTerminal = attempts.length > 0 && attempts.every((attempt) => TERMINAL_ATTEMPT_STATES.has(attempt.status));
    const outputProjected = attempts.every((attempt) => {
      if (attempt.status !== "succeeded" || !attempt.creativeRunItemId) return true;
      const item = itemById.get(attempt.creativeRunItemId);
      const asset = item?.mediaAsset ?? item?.job?.assets[0] ?? null;
      return Boolean(asset && !asset.deletedAt && asset.safetyStatus === "passed");
    });
    if (!allTerminal || !outputProjected) {
      pending += 1;
      await db.controlPlaneCommand.update({
        where: { id: command.id },
        data: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      continue;
    }
    const recoveredItemIds = attempts.flatMap((attempt) => {
      if (attempt.status !== "succeeded" || !attempt.creativeRunItemId) return [];
      const item = itemById.get(attempt.creativeRunItemId);
      const asset = item?.mediaAsset ?? item?.job?.assets[0] ?? null;
      return asset && asset.safetyStatus === "passed" ? [attempt.creativeRunItemId] : [];
    });
    const verificationPassed = recoveredItemIds.length === attempts.length;
    await db.$transaction(async (tx) => {
      const run = await tx.contentProductionBatch.update({
        where: { id: command.targetId },
        data: {
          workflowStage: verificationPassed ? "review" : "generation",
          verificationState: verificationPassed ? "pending" : "failed",
          status: verificationPassed ? "reviewing" : "completed",
          version: { increment: 1 },
        },
      });
      const result = {
        runId: run.id,
        runVersion: run.version,
        attempted: attempts.length,
        recovered: recoveredItemIds.length,
        recoveredItemIds,
        verificationState: verificationPassed ? "passed" : "failed",
      };
      await tx.controlPlaneCommand.update({
        where: { id: command.id },
        data: {
          status: verificationPassed ? "succeeded" : "failed",
          result: toInputJson(result),
          error: verificationPassed ? Prisma.DbNull : toInputJson({ code: "creative_retry_verification_failed", ...result }),
          needsReconciliation: false,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          finishedAt: new Date(),
        },
      });
      await tx.controlPlaneCommandAttempt.updateMany({
        where: { commandId: command.id, attemptNo: command.attemptCount, status: "running" },
        data: {
          status: verificationPassed ? "succeeded" : "failed",
          error: verificationPassed ? Prisma.DbNull : toInputJson({ code: "creative_retry_verification_failed" }),
          finishedAt: new Date(),
        },
      });
      await tx.adminAuditLog.create({
        data: {
          actorId: command.actorId,
          actorRole: "verification_worker",
          action: "creative.run.retry_verified",
          targetType: "creative_run",
          targetId: run.id,
          reason: verificationPassed ? "All retried items produced valid assets" : "One or more retried items did not recover",
          after: toInputJson(result),
          requestId: command.requestId,
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: verificationPassed ? "creative.retry.verified.v2" : "creative.retry.verification_failed.v2",
          aggregateType: "creative_run",
          aggregateId: run.id,
          payload: toInputJson({ commandId: command.id, ...result }),
        },
      });
    });
    if (verificationPassed) passed += 1;
    else failed += 1;
  }
  return { examined: commands.length, passed, failed, pending };
}
