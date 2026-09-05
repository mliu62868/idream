import type { Prisma } from "@prisma/client";
import { unknownGenerationReconciliationResultSchema } from "@idream/shared/admin";
import { aiFinalizePayloadSchema } from "@idream/shared/contracts";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

type UnknownResolutionEvidenceDb = Pick<Prisma.TransactionClient, "generationAttempt" | "generationJobEvent" | "inboundEventReceipt">;
export type AutomaticFailureCorrectionDb = UnknownResolutionEvidenceDb & Pick<Prisma.TransactionClient, "generationJob" | "controlPlaneCommand" | "dreamcoinLedger">;

export const RECOVERED_SUCCESS_EVENT_TYPES = [
  "unknown_terminal_evidence_recovered",
  "unknown_terminal_resolution_evidence_recovered",
] as const;

export async function validatedUnknownSuccessResolution(
  tx: UnknownResolutionEvidenceDb,
  attemptId: string,
) {
  const attempt = await tx.generationAttempt.findUnique({
    where: { id: attemptId },
    select: { requestId: true, status: true },
  });
  if (!attempt || attempt.status !== "unknown") return null;
  const event = await tx.generationJobEvent.findFirst({
    where: {
      jobId: attempt.requestId,
      type: { in: [...RECOVERED_SUCCESS_EVENT_TYPES] },
      metadata: { path: ["attemptId"], equals: attemptId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const metadata = jsonRecord(event?.metadata);
  const parsed = aiFinalizePayloadSchema.safeParse(metadata.recoveredSuccess);
  if (
    !event ||
    !parsed.success ||
    parsed.data.kind !== "generation.completed" ||
    parsed.data.attemptId !== attemptId ||
    parsed.data.generationJobId !== attempt.requestId
  ) return null;
  const expectedHash = canonicalSha256({
    terminalRecordRef: parsed.data.terminalRecordRef,
    terminalRecordChecksum: parsed.data.terminalRecordChecksum,
  });
  const receiptSource = recoveredReceiptSource(event.type);
  if (!receiptSource) return null;
  const receipt = await tx.inboundEventReceipt.findUnique({
    where: {
      sourceService_sourceEventId: {
        sourceService: receiptSource,
        sourceEventId: attemptId,
      },
    },
  });
  if (
    receipt?.processingState !== "processed" ||
    !recoveredReceiptHashMatches(
      receiptSource,
      receipt.payloadHash,
      expectedHash,
      parsed.data.terminalRecordChecksum,
    ) ||
    (receiptSource === "gen_resolution" &&
      (metadata.resolutionReceiptId !== receipt.id ||
        metadata.resolutionPayloadHash !== expectedHash))
  ) return null;
  return { payload: parsed.data, receiptId: receipt.id, eventId: event.id };
}

export function recoveredReceiptSource(eventType: string) {
  if (eventType === "unknown_terminal_evidence_recovered") return "gen" as const;
  if (eventType === "unknown_terminal_resolution_evidence_recovered") {
    return "gen_resolution" as const;
  }
  return null;
}

export function recoveredReceiptHashMatches(
  source: "gen" | "gen_resolution",
  actual: string,
  envelopeHash: string,
  terminalRecordChecksum: string,
) {
  return actual === envelopeHash ||
    (source === "gen" && actual === terminalRecordChecksum);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


export const AUTOMATIC_UNKNOWN_SETTLEMENT_ACTOR_ID = "system:generation-unknown-sweeper";

// A later verified fact may compensate an automatic timeout decision, but never
// erase it, contradict an operator decision, or silently undo a customer refund.
export async function validatedAutomaticFailureCorrection(
  tx: AutomaticFailureCorrectionDb,
  requestId: string,
  attemptId: string,
) {
  const [request, decisions, success, refunds] = await Promise.all([
    tx.generationJob.findUnique({ where: { id: requestId }, select: { status: true, errorCode: true, deliveredOutputCount: true } }),
    tx.generationJobEvent.findMany({ where: { jobId: requestId, type: { in: ["unknown_reconciliation_confirm_failed", "unknown_reconciliation_adopt_succeeded"] }, metadata: { path: ["attemptId"], equals: attemptId } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }),
    validatedUnknownSuccessResolution(tx, attemptId),
    tx.dreamcoinLedger.count({ where: { sourceId: requestId, reason: "refund", delta: { gt: 0 } } }),
  ]);
  const decision = decisions[0];
  const metadata = jsonRecord(decision?.metadata);
  if (!request || request.status !== "failed" || request.errorCode !== "operator_confirmed_provider_failure" ||
    request.deliveredOutputCount !== 0 || refunds !== 0 || !success || success.payload.generationJobId !== requestId ||
    decision?.type !== "unknown_reconciliation_confirm_failed" || metadata.actorId !== AUTOMATIC_UNKNOWN_SETTLEMENT_ACTOR_ID ||
    metadata.resolution !== "confirm_failed" || metadata.refundAmount !== 0 || metadata.deliveredCount !== 0 ||
    typeof metadata.commandId !== "string") return null;
  const [command, event] = await Promise.all([
    tx.controlPlaneCommand.findUnique({ where: { id: metadata.commandId } }),
    tx.generationJobEvent.findUnique({ where: { id: success.eventId } }),
  ]);
  const result = unknownGenerationReconciliationResultSchema.safeParse(command?.result);
  if (!command || command.status !== "succeeded" || command.commandType !== "generation.request.reconcile_unknown" ||
    command.targetId !== requestId || command.actorId !== AUTOMATIC_UNKNOWN_SETTLEMENT_ACTOR_ID ||
    command.idempotencyKey !== `generation-unknown-sweep:${requestId}:${attemptId}` ||
    !result.success || result.data.commandId !== command.id || result.data.requestId !== requestId ||
    result.data.attemptId !== attemptId || result.data.resolution !== "confirm_failed" || result.data.refundAmount !== 0 ||
    result.data.deliveredCount !== 0 || result.data.requestStatus !== "failed" ||
    !event || event.createdAt <= decision.createdAt) return null;
  return { priorDecisionId: decision.id, priorCommandId: command.id, recoveredEventId: event.id };
}
