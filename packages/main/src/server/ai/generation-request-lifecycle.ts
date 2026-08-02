import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  recordGenerationAttemptEvent,
} from "./generation-attempt-events";
import {
  cancelGenerationAttemptDispatchOutboxes,
  reserveRetryGenerationAttempt,
} from "@/server/modules/generation/generation-attempt-authority";
import { ensureGenerationSettlementLinks } from "./generation-settlement";
import { postDreamcoinEntry } from "@/server/modules/admin/billing/ledger";
import { transitionGenerationRequest } from "./generation-request-transition";
import { removeGenerationAttemptQueueJob } from "./generation-attempt-queue";

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
    await removeLatestGenerationAttemptQueueJob(input.requestId);
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
    if (attempt && !["succeeded", "failed", "blocked", "cancelled", "unknown"].includes(attempt.status)) {
      await recordGenerationAttemptEvent(tx, { eventId: `${attempt.id}:terminal`, attemptId: attempt.id, eventType: "generation.attempt.cancelled.v1", outcome: "cancelled", occurredAt: cancelledAt, payload: { requestId: job.id, reason: input.reason }, retryability: "not_retryable" });
    }
    if (attempt) {
      await cancelGenerationAttemptDispatchOutboxes(tx, {
        requestId: job.id,
        attemptId: attempt.id,
        cancelledAt,
        reason: input.reason,
      });
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
  await removeLatestGenerationAttemptQueueJob(input.requestId);
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
    const commandId = randomUUID();
    const reservation = await reserveRetryGenerationAttempt(tx, {
      requestId: input.requestId,
      expectedRequestVersion: input.expectedVersion,
      sourceCommandId: commandId,
      dispatch: {
        outboxId: `generation_retry_${commandId}`,
        eventType: "generation.retry.dispatch.v2",
        payload: { commandId },
      },
    });
    const { attempt, request: updated } = reservation;
    const job = reservation.previousRequest;
    const latest = reservation.previousAttempt;
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
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function removeLatestGenerationAttemptQueueJob(requestId: string) {
  try {
    const attempt = await prisma.generationAttempt.findFirst({
      where: { requestId },
      orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
    if (!attempt) return;
    await removeGenerationAttemptQueueJob({
      requestId,
      attemptId: attempt.id,
    });
  } catch {
    // The durable cancelled authority suppresses any late worker result. Queue
    // removal is an optimization and is retried by idempotent command replay.
  }
}
