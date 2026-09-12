import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import { refundGenerationRequest } from "@/server/ai/generation-refund";
import { transitionGenerationRequest } from "@/server/ai/generation-request-transition";
import { cancelGenerationAttemptDispatchOutboxes } from "@/server/modules/generation/generation-attempt-authority";
import { appendGenerationEvent } from "@/server/modules/ourdream/generation-job-authority";
import { jsonRecord } from "@/server/modules/ourdream/json-values";

// A provider submission may already have happened after a dispatch timeout.
// Only an untouched dispatch fact proves that cancellation stops paid execution.
export async function cancelChatVideo(userId: string, requestId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "generation_jobs" WHERE id = ${requestId} AND "userId" = ${userId} FOR UPDATE`;
    const job = await tx.generationJob.findFirst({ where: { id: requestId, userId, sourceType: "chat_video" } });
    if (!job) throw Errors.notFound("Chat video request not found");
    if (job.status === "cancelled") return { requestId, status: "cancelled" as const, refundAmount: 0 };
    const attempt = await tx.generationAttempt.findFirst({ where: { requestId }, orderBy: { attemptNo: "desc" } });
    const dispatches = attempt ? await tx.mainOutboxEvent.findMany({ where: {
      aggregateType: "generation_request", aggregateId: requestId,
      eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
    }, select: { status: true, attempts: true, payload: true } }) : [];
    const exact = dispatches.filter(item => jsonRecord(item.payload).attemptId === attempt?.id);
    if (job.status !== "queued" || !attempt || attempt.status !== "queued" || attempt.startedAt !== null ||
      exact.length === 0 || exact.some(item => item.status !== "pending" || item.attempts !== 0)) {
      throw Errors.conflict("This video has already entered processing and can no longer be cancelled. Its result will stay in this chat.", { reason: "processing_started" });
    }
    const cancelledAt = new Date();
    await transitionGenerationRequest(tx, { requestId, to: "cancelled", expected: { from: "queued", version: job.version }, data: { completedAt: null, finishedAt: cancelledAt, deliveredOutputCount: 0 } });
    await recordGenerationAttemptEvent(tx, {
      eventId: `${attempt.id}:terminal`, attemptId: attempt.id,
      eventType: "generation.attempt.cancelled.v1", outcome: "cancelled", occurredAt: cancelledAt,
      payload: { requestId, reason: "User cancelled before execution" }, retryability: "not_retryable",
    });
    await cancelGenerationAttemptDispatchOutboxes(tx, { requestId, attemptId: attempt.id, cancelledAt, reason: "User cancelled before execution" });
    await tx.chatTurnAttachment.updateMany({ where: { generationJobId: requestId, kind: "generated_video" }, data: { status: "cancelled", errorCode: null } });
    const refundAmount = await refundGenerationRequest(tx, { requestId, userId, cause: { kind: "cancel" } });
    await appendGenerationEvent(tx, requestId, "cancelled", "Video cancelled before execution", { refundAmount, actorId: userId });
    if (refundAmount > 0) await appendGenerationEvent(tx, requestId, "refunded", "Dreamcoins returned after cancellation", { amount: refundAmount });
    return { requestId, status: "cancelled" as const, refundAmount };
  });
}
