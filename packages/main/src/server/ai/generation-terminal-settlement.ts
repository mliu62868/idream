// SPEC: settles a Request that ended without delivery: refund, failed or blocked
// state, and the attachment and production projections that follow from them.
import { prisma } from "@/server/lib/db";
import { markProductionItemFailed } from "@/server/modules/content-production-state";
import { recordGenerationAttemptEvent } from "./generation-attempt-events";
import { transitionGenerationRequest } from "./generation-request-transition";
import { refundGenerationRequest } from "./generation-refund";
import { lockGenerationRequestForSettlement } from "./generation-settlement";
import {
  projectAttemptArtifactDisposition,
} from "./generation-evidence-transition-authority";
import { appendGenerationEvent, markGenerationTerminalRecordDelivered, toInputJson } from "./generation-finalize-events";

export async function refundGeneration(
  userId: string,
  jobId: string,
  cost: number,
  status: "failed" | "blocked",
  errorCode: string,
  sourceType: string,
  attemptId?: string,
  // INVARIANT: refunding settles a Request as failed/blocked, so the Attempt
  // outcome recorded here is never the ambiguous one — an unknown provider
  // outcome holds the funds and goes to operator reconciliation instead.
  terminal: {
    attemptOutcome?: "failed" | "blocked";
    retryability?: "retryable" | "not_retryable" | "operator_retry";
    terminalRecordRef?: string;
    terminalRecordChecksum?: string;
    moderation?: { layer: string; policyCode: string; message: string };
  } = {},
) {
  // INVARIANT: content_production jobs are never debited, so they must never be
  // credited on refund — their costDreamcoins is record-keeping only (ops batches
  // don't charge a wallet on creation).
  const isDebitedJob = sourceType !== "content_production_item";
  return prisma.$transaction(async (tx) => {
    await lockGenerationRequestForSettlement(tx, jobId);
    // A duplicate finalizer can pause before locking while another execution
    // settles this Attempt and an operator starts the next one. Only the latest
    // Attempt may mutate the Request, attachments or settlement under this lock.
    if (attemptId) {
      const latest = await tx.generationAttempt.findFirst({
        where: { requestId: jobId },
        orderBy: [{ attemptNo: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      if (latest?.id !== attemptId) return false;
    }
    const transitioned = await transitionGenerationRequest(tx, {
      requestId: jobId,
      to: status,
      expected: { from: ["queued", "moderating_input", "running", "moderating_output"] },
      data: {
        errorCode,
        completedAt: null,
        finishedAt: new Date(),
        deliveredOutputCount: 0,
      },
      onConflict: "return-null",
    });
    if (!transitioned) return false;
    if (sourceType === "chat_image" || sourceType === "chat_video") {
      await tx.chatTurnAttachment.updateMany({
        where: { generationJobId: jobId },
        data: { status, errorCode },
      });
    }
    if (terminal.moderation) {
      await tx.moderationEvent.create({
        data: {
          targetType: "generation_job",
          targetId: jobId,
          layer: terminal.moderation.layer,
          status: "blocked",
          policyCode: terminal.moderation.policyCode,
          confidence: 1,
          details: toInputJson({ message: terminal.moderation.message }),
        },
      });
    }
    const refundAmount = isDebitedJob
      ? (await refundGenerationRequest(tx, {
          requestId: jobId,
          userId,
          cause: { kind: "failed" },
          requested: cost,
        }))
      : 0;
    if (attemptId) {
      await projectAttemptArtifactDisposition(tx, {
        requestId: jobId,
        attemptId,
        targetId: userId,
        validationState: status === "blocked" ? "rejected" : "invalid",
        deliveryStatus: "failed",
        occurredAt: new Date(),
      });
      const attempt = await tx.generationAttempt.findFirstOrThrow({
        where: { id: attemptId, requestId: jobId },
      });
      const finishedAt = attempt.finishedAt ?? new Date();
      const attemptOutcome = terminal.attemptOutcome ?? "failed";
      if (attempt.status !== attemptOutcome) {
        if (["succeeded", "failed", "blocked", "cancelled", "unknown"].includes(attempt.status)) {
          throw new Error(
            `Generation Attempt ${attemptId} already ended as ${attempt.status}, cannot settle Request as ${attemptOutcome}`,
          );
        }
        await recordGenerationAttemptEvent(tx, {
          eventId: `${attemptId}:terminal`,
          attemptId,
          eventType: `generation.attempt.${attemptOutcome}.v1`,
          outcome: attemptOutcome,
          occurredAt: finishedAt,
          payload: {
            requestId: jobId,
            requestOutcome: status,
            errorCode,
            refundAmount,
            terminalRecordChecksum: terminal.terminalRecordChecksum ?? null,
          },
          terminalRecordRef: terminal.terminalRecordRef ?? null,
          errorCode,
          retryability: terminal.retryability ?? (status === "failed" ? "retryable" : "not_retryable"),
        });
      }
      await markGenerationTerminalRecordDelivered(tx, attemptId);
    }
    await markProductionItemFailed(tx, jobId);
    await appendGenerationEvent(tx, jobId, status, `Generation job ${status}`, {
      errorCode,
    });
    if (refundAmount > 0) await appendGenerationEvent(tx, jobId, "refunded", "Dreamcoins refunded", {
      amount: refundAmount,
    });
    return true;
  });
}
