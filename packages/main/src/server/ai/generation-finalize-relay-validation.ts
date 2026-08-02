import type { PrismaClient } from "@prisma/client";
import { aiFinalizePayloadSchema } from "./schemas";
import { prisma } from "@/server/lib/db";
import {
  bullMqJobIdForDedupeKey,
  type QueueJobSnapshot,
} from "@/server/jobs/queue";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

export type FinalizeRelayValidation =
  | { readonly valid: true; readonly attemptId: string }
  | { readonly valid: false; readonly reason: string };

// SPEC: exhausted finalization may be reset only against the exact Attempt and
// the durable terminal Outbox whose immutable payload created the Bull row.
export async function validateGenerationFinalizeRelaySnapshot(
  row: Pick<QueueJobSnapshot, "id" | "queue" | "payload" | "dedupeKey">,
  db: PrismaClient = prisma,
): Promise<FinalizeRelayValidation> {
  if (row.queue !== "app.ai.finalize") {
    return { valid: false, reason: "wrong_queue" };
  }
  const parsed = aiFinalizePayloadSchema.safeParse(row.payload);
  if (!parsed.success) return { valid: false, reason: "invalid_schema" };
  if (![
    "generation.completed",
    "generation.failed",
    "generation.unknown",
    "generation.blocked",
  ].includes(parsed.data.kind)) {
    return { valid: false, reason: "unsupported_kind" };
  }
  const raw = parsed.data as Record<string, unknown>;
  if (
    typeof raw.attemptId !== "string" ||
    typeof raw.generationJobId !== "string" ||
    typeof raw.terminalRecordRef !== "string" ||
    !Number.isSafeInteger(raw.attemptNo) ||
    (raw.mode !== "image" && raw.mode !== "video")
  ) return { valid: false, reason: "invalid_generation_identity" };
  const payload = {
    attemptId: raw.attemptId,
    attemptNo: raw.attemptNo as number,
    generationJobId: raw.generationJobId,
    terminalRecordRef: raw.terminalRecordRef,
    mode: raw.mode,
  };
  const dedupeKey = `generation-terminal-record-finalize:${payload.attemptId}`;
  if (row.dedupeKey !== dedupeKey) {
    return { valid: false, reason: "dedupe_mismatch" };
  }
  if (row.id !== bullMqJobIdForDedupeKey(dedupeKey)) {
    return { valid: false, reason: "bull_job_id_mismatch" };
  }
  const [attempt, job, outboxes] = await Promise.all([
    db.generationAttempt.findUnique({ where: { id: payload.attemptId } }),
    db.generationJob.findUnique({
      where: { id: payload.generationJobId },
      select: { mode: true },
    }),
    db.mainOutboxEvent.findMany({
      where: {
        aggregateType: "generation_attempt",
        aggregateId: payload.attemptId,
        eventType: "generation.terminal_record.accepted.v1",
      },
    }),
  ]);
  if (
    !attempt ||
    !job ||
    attempt.requestId !== payload.generationJobId ||
    attempt.attemptNo !== payload.attemptNo ||
    attempt.terminalRecordRef !== payload.terminalRecordRef ||
    job.mode !== payload.mode
  ) {
    return { valid: false, reason: "db_authority_mismatch" };
  }
  if (
    outboxes.length !== 1 ||
    canonicalSha256(outboxes[0]!.payload) !== canonicalSha256(row.payload)
  ) {
    return { valid: false, reason: "terminal_outbox_mismatch" };
  }
  return { valid: true, attemptId: attempt.id };
}
