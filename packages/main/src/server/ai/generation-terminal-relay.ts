// SPEC: The Main-owned terminal relay consumes immutable Gen evidence from
// BullMQ and invokes the same idempotent ingest authority as the internal API.
// INTENT: Transport retries and process restarts stay outside provider workers.
import {
  generationTerminalRecordIngestSchema,
  MAIN_QUEUES,
  type GenerationTerminalRecordIngest,
} from "@idream/shared/contracts";
import {
  jobQueue,
  type JobQueue,
  type QueueJobSnapshot,
} from "@/server/jobs/queue";
import { ingestGenerationTerminalRecord } from "./generation-terminal-record-ingest";
import { validateGenerationTerminalRelaySnapshot } from "./generation-terminal-relay-validation";
import { validateGenerationFinalizeRelaySnapshot } from "./generation-finalize-relay-validation";

type TerminalIngest = (
  input: GenerationTerminalRecordIngest,
) => Promise<{
  readonly acknowledged: boolean;
  readonly status: "persisted" | "duplicate" | "quarantined";
  readonly receiptId: string | null;
}>;

export async function consumeGenerationTerminalRelay(
  rawPayload: unknown,
  ingest: TerminalIngest = ingestGenerationTerminalRecord,
) {
  const payload = generationTerminalRecordIngestSchema.parse(rawPayload);
  // A quarantined receipt is already a durable Main decision. Only thrown
  // infrastructure errors retry the Bull row; immutable invalid evidence must
  // not churn forever in the relay.
  const result = await ingest(payload);
  // No receipt means Main did not durably own the rejection. Completing this
  // Bull row would erase the only retryable hand-off for the terminal record.
  if (!result.acknowledged && result.receiptId === null) {
    throw new Error(
      `generation terminal ingest was not durably acknowledged for ${payload.terminalRecord.attemptId}`,
    );
  }
  return result;
}

type TerminalRelayRedriveQueue = Pick<
  JobQueue,
  "inspectFailed" | "retryFailedByDedupeKey"
>;

export type FailedRelayScanCursor = { offset: number };
const defaultFailedRelayScanCursor: FailedRelayScanCursor = { offset: 0 };

export async function redriveFailedGenerationTerminalRelays(options: {
  readonly queue?: TerminalRelayRedriveQueue;
  readonly cursor?: FailedRelayScanCursor;
} = {}) {
  const queue = options.queue ?? jobQueue;
  const cursor = options.cursor ?? defaultFailedRelayScanCursor;
  const queueNames = [
    MAIN_QUEUES.generationTerminalIngest,
    MAIN_QUEUES.aiFinalize,
  ] as const;
  const scanOffset = Math.max(0, cursor.offset);
  const failedRows = await queue.inspectFailed(queueNames, {
    limit: 100,
    offset: scanOffset,
  });
  // INTENT: invalid failed evidence remains visible, but cannot permanently
  // starve exact rows behind the first page. A short final page wraps the next
  // periodic scan back to the beginning.
  cursor.offset = failedRows.length < 100
    ? 0
    : scanOffset + failedRows.length;
  const invalid: Array<{
    readonly bullJobId: string;
    readonly reason: string;
  }> = [];
  const valid: QueueJobSnapshot[] = [];
  const retryErrors: Array<{ readonly bullJobId: string; readonly error: string }> = [];
  for (const row of failedRows) {
    try {
      const validation = row.queue === MAIN_QUEUES.generationTerminalIngest
        ? validateGenerationTerminalRelaySnapshot(row)
        : await validateGenerationFinalizeRelaySnapshot(row);
      if (!validation.valid) {
        invalid.push({ bullJobId: row.id, reason: validation.reason });
      } else {
        valid.push(row);
      }
    } catch (error) {
      retryErrors.push({
        bullJobId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let redriven = 0;
  let deferredPaused = 0;
  for (const row of valid) {
    try {
      const result = await queue.retryFailedByDedupeKey({
        queue: row.queue,
        dedupeKey: row.dedupeKey!,
        resetAttemptsMade: true,
      });
      if (result.status === "retried") redriven += 1;
      if (
        result.status === "queue_paused" ||
        result.status === "retried_paused"
      ) deferredPaused += 1;
    } catch (error) {
      retryErrors.push({
        bullJobId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    scanned: failedRows.length,
    redriven,
    deferredPaused,
    invalid,
    retryErrors,
  } as const;
}
