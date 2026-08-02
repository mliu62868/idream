import {
  GEN_QUEUES,
  generationProviderIdempotencyKey,
  idempotencyKeys,
  imageGeneratePayloadSchema,
  videoGeneratePayloadSchema,
  type ImageGeneratePayload,
  type VideoGeneratePayload,
} from "@idream/shared/contracts";
import type { BlobStore } from "./providers";
import {
  bullMqJobIdForDedupeKey,
  inspectFailed,
  isQueuePaused,
  retryFailedByDedupeKey,
  type QueueJobSnapshot,
  type RetryFailedJobResult,
} from "./queue";
import { loadPersistedTerminalRecord } from "./terminal-record";

type GenerationMode = "image" | "video";
type SourcePayload = ImageGeneratePayload | VideoGeneratePayload;

export type FailedSourceScanCursor = { offset: number };

export type FailedSourceRecoveryQueue = {
  inspectFailed(
    queue: string,
    options: { limit: number; offset: number },
  ): Promise<QueueJobSnapshot[]>;
  isPaused(queue: string): Promise<boolean>;
  retry(input: {
    queue: string;
    dedupeKey: string;
    resetAttemptsMade: boolean;
  }): Promise<RetryFailedJobResult>;
};

const bullQueue: FailedSourceRecoveryQueue = {
  inspectFailed,
  isPaused: isQueuePaused,
  retry: retryFailedByDedupeKey,
};

const defaultCursors: Record<GenerationMode, FailedSourceScanCursor> = {
  image: { offset: 0 },
  video: { offset: 0 },
};

// SPEC: a source Bull row may be retried after exhaustion only when the exact
// immutable terminal record is already durable in Blob. Pipeline resume then
// relays that record before any moderation or provider invocation.
export async function recoverFailedGenerationSourceJobs(input: {
  readonly mode: GenerationMode;
  readonly blob: BlobStore;
  readonly queue?: FailedSourceRecoveryQueue;
  readonly cursor?: FailedSourceScanCursor;
  readonly limit?: number;
}) {
  const queue = input.queue ?? bullQueue;
  const queueName = input.mode === "video"
    ? GEN_QUEUES.videoGenerate
    : GEN_QUEUES.imageGenerate;
  const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
  const cursor = input.cursor ?? defaultCursors[input.mode];
  const scanOffset = Math.max(0, cursor.offset);
  const [rows] = await Promise.all([
    queue.inspectFailed(queueName, { limit, offset: scanOffset }),
    queue.isPaused(queueName),
  ]);
  cursor.offset = rows.length < limit ? 0 : scanOffset + rows.length;

  const invalid: Array<{ bullJobId: string; reason: string }> = [];
  const retryErrors: Array<{ bullJobId: string; error: string }> = [];
  let recovered = 0;
  let deferredPaused = 0;
  for (const row of rows) {
    try {
      const validation = await validateRecoverableSourceRow(
        input.mode,
        input.blob,
        row,
      );
      if (!validation.valid) {
        invalid.push({ bullJobId: row.id, reason: validation.reason });
        continue;
      }
      const result = await queue.retry({
        queue: queueName,
        dedupeKey: validation.dedupeKey,
        resetAttemptsMade: true,
      });
      if (result.status === "retried") recovered += 1;
      else if (
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
    scanned: rows.length,
    recovered,
    deferredPaused,
    invalid,
    retryErrors,
  } as const;
}

async function validateRecoverableSourceRow(
  mode: GenerationMode,
  blob: BlobStore,
  row: QueueJobSnapshot,
): Promise<
  | { valid: true; dedupeKey: string; payload: SourcePayload }
  | { valid: false; reason: string }
> {
  const queueName = mode === "video"
    ? GEN_QUEUES.videoGenerate
    : GEN_QUEUES.imageGenerate;
  if (row.queue !== queueName) return { valid: false, reason: "wrong_queue" };
  const parsed = mode === "video"
    ? videoGeneratePayloadSchema.safeParse(row.payload)
    : imageGeneratePayloadSchema.safeParse(row.payload);
  if (!parsed.success) return { valid: false, reason: "invalid_schema" };
  const payload = parsed.data;
  const dedupeKey = idempotencyKeys.generationAttempt(
    payload.generationJobId,
    payload.attemptNo,
  );
  if (row.dedupeKey !== dedupeKey) {
    return { valid: false, reason: "dedupe_mismatch" };
  }
  if (row.id !== bullMqJobIdForDedupeKey(dedupeKey)) {
    return { valid: false, reason: "bull_job_id_mismatch" };
  }
  const persisted = await loadPersistedTerminalRecord(blob, payload.attemptId);
  if (!persisted) return { valid: false, reason: "terminal_record_missing" };
  const record = persisted.terminalRecord;
  if (
    record.attemptId !== payload.attemptId ||
    record.attemptNo !== payload.attemptNo ||
    record.generationJobId !== payload.generationJobId ||
    record.requestId !== payload.requestId ||
    record.mode !== payload.kind ||
    record.provider !== payload.provider ||
    record.model !== payload.model ||
    record.providerIdempotencyKey !== generationProviderIdempotencyKey(payload.attemptId)
  ) {
    return { valid: false, reason: "terminal_identity_mismatch" };
  }
  return { valid: true, dedupeKey, payload };
}

export function startGenerationSourceRecovery(input: {
  readonly mode: GenerationMode;
  readonly blob: BlobStore;
  readonly intervalMs?: number;
  readonly onResult?: (
    result: Awaited<ReturnType<typeof recoverFailedGenerationSourceJobs>>,
  ) => void;
  readonly onError?: (error: unknown) => void;
}) {
  let closed = false;
  let running: Promise<void> | null = null;
  const scan = () => {
    if (closed || running) return;
    running = recoverFailedGenerationSourceJobs(input)
      .then((result) => input.onResult?.(result))
      .catch((error) => input.onError?.(error))
      .finally(() => { running = null; });
  };
  scan();
  const timer = setInterval(scan, input.intervalMs ?? 60_000);
  timer.unref();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
