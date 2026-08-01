import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { jobQueue } from "@/server/jobs/queue";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  recordGenerationAttemptEvent,
  recordGenerationAttemptQueuedEvent,
} from "./generation-attempt-events";
import { ensureGenerationSettlementLinks } from "./generation-settlement";
import { postDreamcoinEntry } from "@/server/modules/admin/billing/ledger";
import { transitionGenerationRequest } from "./generation-request-transition";

export async function cancelGenerationRequest(input: {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly actor: { readonly id: string; readonly role: string };
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
}) {
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalSha256({ commandType: "generation.request.cancel", requestId: input.requestId, expectedVersion: input.expectedVersion, reason: input.reason });
  const existing = await prisma.controlPlaneCommand.findUnique({ where: { scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    if (existing.requestHash !== requestHash) throw Errors.conflict("Idempotency key is bound to another Generation Request cancellation");
    await removeGenerationTransportJob(input.requestId);
    return existing.result;
  }
  const result = await prisma.$transaction(async (tx) => {
    const job = await tx.generationJob.findUnique({ where: { id: input.requestId } });
    if (!job) throw Errors.notFound("Generation Request not found");
    if (job.version !== input.expectedVersion) throw Errors.conflict("Generation Request changed before cancellation");
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${job.id} FOR UPDATE`;
    const cancelledAt = new Date();
    const cancelled = await transitionGenerationRequest(tx, {
      requestId: job.id,
      to: "cancelled",
      expected: {
        from: ["queued", "moderating_input", "running", "moderating_output"],
        version: input.expectedVersion,
      },
      data: {
        completedAt: null,
        finishedAt: cancelledAt,
        deliveredOutputCount: 0,
      },
    });
    const attempt = await tx.generationAttempt.findFirst({ where: { requestId: job.id }, orderBy: { attemptNo: "desc" } });
    if (attempt && !["succeeded", "failed", "cancelled", "unknown"].includes(attempt.status)) {
      await recordGenerationAttemptEvent(tx, { eventId: `${attempt.id}:terminal`, attemptId: attempt.id, eventType: "generation.attempt.cancelled.v1", outcome: "cancelled", occurredAt: cancelledAt, payload: { requestId: job.id, reason: input.reason }, retryability: "not_retryable" });
    }
    const settlement = await ensureGenerationSettlementLinks(tx, job.id);
    let refundAmount = 0;
    if (settlement.refundable > 0) {
      const refund = await postDreamcoinEntry(tx, {
        kind: "refund",
        userId: job.userId,
        amount: settlement.refundable,
        sourceId: job.id,
        idempotencyKey: `generation:${job.id}:cancel-refund`,
      });
      refundAmount = refund.delta;
    }
    const response = { requestId: job.id, status: cancelled.status, version: cancelled.version, finishedAt: cancelledAt.toISOString(), refundAmount };
    const command = await tx.controlPlaneCommand.create({ data: { scope, idempotencyKey: input.idempotencyKey, commandType: "generation.request.cancel", targetType: "generation_request", targetId: job.id, actorId: input.actor.id, requestId: input.traceId, requestHash, requestPayload: toInputJson({ expectedVersion: input.expectedVersion, reason: input.reason }), expectedVersion: input.expectedVersion, retryMode: "idempotent", status: "succeeded", result: toInputJson(response), finishedAt: cancelledAt } });
    await tx.adminAuditLog.create({ data: { actorId: input.actor.id, actorRole: input.actor.role, action: "generation.request.cancelled", targetType: "generation_request", targetId: job.id, reason: input.reason, before: toInputJson({ status: job.status, version: job.version }), after: toInputJson({ ...response, commandId: command.id }), requestId: input.traceId } });
    await tx.mainOutboxEvent.create({ data: { eventType: "generation.request.cancelled.v2", aggregateType: "generation_request", aggregateId: job.id, payload: toInputJson({ ...response, commandId: command.id }) } });
    return response;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  await removeGenerationTransportJob(input.requestId);
  return result;
}

export async function retryGenerationRequest(input: {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly actor: { readonly id: string; readonly role: string };
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
}) {
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const requestHash = canonicalSha256({
    commandType: "generation.request.retry",
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
  });
  const existing = await prisma.controlPlaneCommand.findUnique({
    where: { scope_idempotencyKey: { scope, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw Errors.conflict("Idempotency key is bound to another Generation Request retry");
    }
    return existing.result;
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${input.requestId} FOR UPDATE`;
    const job = await tx.generationJob.findUnique({ where: { id: input.requestId } });
    if (!job) throw Errors.notFound("Generation Request not found");
    if (job.version !== input.expectedVersion) {
      throw Errors.conflict("Generation Request changed before retry", {
        expectedVersion: input.expectedVersion,
        currentVersion: job.version,
      });
    }
    const delivered = await tx.generationDelivery.count({
      where: { requestId: job.id, status: "delivered" },
    });
    if (delivered > 0) {
      throw Errors.conflict("Partially delivered requests require failed-output reconciliation", {
        deliveredCount: delivered,
      });
    }
    const latest = await tx.generationAttempt.findFirst({
      where: { requestId: job.id },
      orderBy: { attemptNo: "desc" },
    });
    if (latest && !["failed", "unknown"].includes(latest.status)) {
      throw Errors.conflict("Latest Generation Attempt is not safe for retry", {
        attemptId: latest.id,
        status: latest.status,
      });
    }
    if (latest?.retryability === "not_retryable") {
      throw Errors.conflict("Latest Generation Attempt is explicitly non-replayable", {
        attemptId: latest.id,
      });
    }
    const updated = await transitionGenerationRequest(tx, {
      requestId: job.id,
      to: "queued",
      expected: { from: "failed", version: input.expectedVersion },
      data: {
        errorCode: null,
        completedAt: null,
        finishedAt: null,
        deliveredOutputCount: 0,
      },
    });
    const commandId = randomUUID();
    const attempt = await tx.generationAttempt.create({
      data: {
        requestId: job.id,
        attemptNo: (latest?.attemptNo ?? 0) + 1,
        provider: latest?.provider ?? job.provider,
        profileKey: latest?.profileKey ?? job.profileId,
        profileVersion: latest?.profileVersion ?? job.profileVersion,
        workflowKey: latest?.workflowKey ?? job.model,
        workflowVersion: latest?.workflowVersion,
        sourceCommandId: commandId,
        status: "queued",
      },
    });
    await recordGenerationAttemptQueuedEvent(tx, attempt);
    const result = {
      commandId,
      requestId: job.id,
      attemptId: attempt.id,
      attemptNo: attempt.attemptNo,
      status: "queued" as const,
      version: updated.version,
    };
    await tx.controlPlaneCommand.create({
      data: {
        id: commandId,
        scope,
        idempotencyKey: input.idempotencyKey,
        commandType: "generation.request.retry",
        targetType: "generation_request",
        targetId: job.id,
        actorId: input.actor.id,
        requestId: input.traceId,
        requestHash,
        requestPayload: toInputJson({ expectedVersion: input.expectedVersion, reason: input.reason }),
        expectedVersion: input.expectedVersion,
        retryMode: "idempotent",
        status: "succeeded",
        result: toInputJson(result),
        finishedAt: new Date(),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "generation.request.retry",
        targetType: "generation_request",
        targetId: job.id,
        reason: input.reason,
        before: toInputJson({
          status: job.status,
          version: job.version,
          latestAttemptId: latest?.id ?? null,
          latestAttemptNo: latest?.attemptNo ?? null,
        }),
        after: toInputJson(result),
        requestId: input.traceId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        id: `generation_retry_${job.id}_${attempt.attemptNo}`,
        eventType: "generation.retry.dispatch.v2",
        aggregateType: "generation_request",
        aggregateId: job.id,
        payload: toInputJson({
          generationJobId: job.id,
          attemptId: attempt.id,
          attemptNo: attempt.attemptNo,
          commandId,
        }),
      },
    });
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function removeGenerationTransportJob(requestId: string) {
  try {
    await jobQueue.removeByDedupePrefix(`generation:${requestId}`, ["ai.image.generate", "ai.video.generate"]);
  } catch {
    // The durable cancelled authority suppresses any late worker result. Queue
    // removal is an optimization and is retried by idempotent command replay.
  }
}
