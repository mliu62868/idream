import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { jobQueue } from "@/server/jobs/queue";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import { ensureGenerationSettlementLinks, linkGenerationLedgerEntry } from "./generation-settlement";

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
    if (!["queued", "moderating_input", "running", "moderating_output"].includes(job.status)) throw Errors.conflict("Only a processing Generation Request can be cancelled");
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${job.id} FOR UPDATE`;
    const cancelledAt = new Date();
    const attempt = await tx.generationAttempt.findFirst({ where: { requestId: job.id }, orderBy: { attemptNo: "desc" } });
    if (attempt && !["succeeded", "failed", "cancelled", "unknown"].includes(attempt.status)) {
      await recordGenerationAttemptEvent(tx, { eventId: `${attempt.id}:terminal`, attemptId: attempt.id, eventType: "generation.attempt.cancelled.v1", outcome: "cancelled", occurredAt: cancelledAt, payload: { requestId: job.id, reason: input.reason }, retryability: "not_retryable" });
    }
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${job.userId} FOR UPDATE`;
    const settlement = await ensureGenerationSettlementLinks(tx, job.id);
    let refundAmount = 0;
    if (settlement.refundable > 0) {
      const balance = await tx.dreamcoinLedger.aggregate({ where: { userId: job.userId }, _sum: { delta: true } });
      const refund = await tx.dreamcoinLedger.create({ data: { userId: job.userId, delta: settlement.refundable, balanceAfter: (balance._sum.delta ?? 0) + settlement.refundable, reason: "refund", sourceId: job.id, idempotencyKey: `generation:${job.id}:cancel-refund` } });
      await linkGenerationLedgerEntry(tx, refund);
      refundAmount = refund.delta;
    }
    const cancelled = await tx.generationJob.update({ where: { id: job.id }, data: { status: "cancelled", completedAt: null, finishedAt: cancelledAt, deliveredOutputCount: 0, version: { increment: 1 } } });
    const response = { requestId: job.id, status: cancelled.status, version: cancelled.version, finishedAt: cancelledAt.toISOString(), refundAmount };
    const command = await tx.controlPlaneCommand.create({ data: { scope, idempotencyKey: input.idempotencyKey, commandType: "generation.request.cancel", targetType: "generation_request", targetId: job.id, actorId: input.actor.id, requestId: input.traceId, requestHash, requestPayload: toInputJson({ expectedVersion: input.expectedVersion, reason: input.reason }), expectedVersion: input.expectedVersion, retryMode: "idempotent", status: "succeeded", result: toInputJson(response), finishedAt: cancelledAt } });
    await tx.adminAuditLog.create({ data: { actorId: input.actor.id, actorRole: input.actor.role, action: "generation.request.cancelled", targetType: "generation_request", targetId: job.id, reason: input.reason, before: toInputJson({ status: job.status, version: job.version }), after: toInputJson({ ...response, commandId: command.id }), requestId: input.traceId } });
    await tx.mainOutboxEvent.create({ data: { eventType: "generation.request.cancelled.v2", aggregateType: "generation_request", aggregateId: job.id, payload: toInputJson({ ...response, commandId: command.id }) } });
    return response;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  await removeGenerationTransportJob(input.requestId);
  return result;
}

async function removeGenerationTransportJob(requestId: string) {
  try {
    await jobQueue.removeByDedupePrefix(`generation:${requestId}`, ["ai.image.generate", "ai.video.generate"]);
  } catch {
    // The durable cancelled authority suppresses any late worker result. Queue
    // removal is an optimization and is retried by idempotent command replay.
  }
}
