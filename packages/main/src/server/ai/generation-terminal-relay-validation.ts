import {
  generationTerminalRecordChecksum,
  generationTerminalRecordIngestSchema,
  idempotencyKeys,
  MAIN_QUEUES,
  type GenerationTerminalRecordIngest,
} from "@idream/shared/contracts";
import {
  bullMqJobIdForDedupeKey,
  type QueueJobSnapshot,
} from "@/server/jobs/queue";

export type TerminalRelayValidation =
  | { readonly valid: true; readonly payload: GenerationTerminalRecordIngest }
  | {
      readonly valid: false;
      readonly reason:
        | "wrong_queue"
        | "invalid_schema"
        | "checksum_mismatch"
        | "dedupe_mismatch"
        | "bull_job_id_mismatch";
    };

// SPEC: Only exact immutable terminal evidence may be automatically redriven.
export function validateGenerationTerminalRelaySnapshot(
  row: Pick<QueueJobSnapshot, "id" | "queue" | "payload" | "dedupeKey">,
): TerminalRelayValidation {
  if (row.queue !== MAIN_QUEUES.generationTerminalIngest) {
    return { valid: false, reason: "wrong_queue" };
  }
  const parsed = generationTerminalRecordIngestSchema.safeParse(row.payload);
  if (!parsed.success) return { valid: false, reason: "invalid_schema" };
  if (
    generationTerminalRecordChecksum(parsed.data.terminalRecord) !==
      parsed.data.terminalRecordChecksum
  ) {
    return { valid: false, reason: "checksum_mismatch" };
  }
  const dedupeKey = idempotencyKeys.generationTerminalRelay(
    parsed.data.terminalRecord.attemptId,
  );
  if (row.dedupeKey !== dedupeKey) {
    return { valid: false, reason: "dedupe_mismatch" };
  }
  if (row.id !== bullMqJobIdForDedupeKey(dedupeKey)) {
    return { valid: false, reason: "bull_job_id_mismatch" };
  }
  return { valid: true, payload: parsed.data };
}
