import {
  GEN_QUEUES,
  generationProviderIdempotencyKey,
  idempotencyKeys,
  type GenerationTerminalRecord,
} from "@idream/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import { recoverFailedGenerationSourceJobs } from "./failed-source-recovery";
import { createMockGenProviders } from "./providers";
import { bullMqJobIdForDedupeKey, type QueueJobSnapshot } from "./queue";
import { persistTerminalRecord } from "./terminal-record";

function payload(attemptId: string) {
  return {
    version: 1 as const,
    kind: "image" as const,
    requestId: `generation_dispatch_${attemptId}`,
    generationJobId: `job-${attemptId}`,
    attemptId,
    attemptNo: 1,
    provider: "mock",
    userId: "user-1",
    characterId: null,
    prompt: "portrait",
    negativePrompt: null,
    controls: {},
    presetIds: [],
    orientation: "1:1",
    count: 1,
    seed: "1",
    model: "mock",
    outputPrefix: `gen/job-${attemptId}/`,
  };
}

function failedRow(value: ReturnType<typeof payload>): QueueJobSnapshot {
  const dedupeKey = idempotencyKeys.generationAttempt(
    value.generationJobId,
    value.attemptNo,
  );
  return {
    id: bullMqJobIdForDedupeKey(dedupeKey),
    queue: GEN_QUEUES.imageGenerate,
    payload: value,
    dedupeKey,
    attemptsMade: 3,
    maxAttempts: 3,
    state: "failed",
    timestamp: Date.now(),
  };
}

describe("failed generation source recovery", () => {
  it("retries only an exact failed source row backed by its Blob terminal record", async () => {
    const providers = createMockGenProviders();
    const suffix = crypto.randomUUID();
    const exact = payload(`recoverable-attempt-${suffix}`);
    const missing = payload(`missing-terminal-attempt-${suffix}`);
    const terminal: GenerationTerminalRecord = {
      version: 1,
      outcome: "failed",
      attemptId: exact.attemptId,
      attemptNo: exact.attemptNo,
      transportAttemptNo: 1,
      providerIdempotencyKey: generationProviderIdempotencyKey(exact.attemptId),
      requestId: exact.requestId,
      generationJobId: exact.generationJobId,
      mode: exact.kind,
      provider: exact.provider,
      providerInvoked: true,
      model: exact.model,
      providerRequestId: null,
      completedAt: new Date().toISOString(),
      usage: {},
      error: { code: "provider_failed", message: "failed", retryability: "retryable" },
    };
    await persistTerminalRecord(providers.blob, terminal);
    const retry = vi.fn(async () => ({ status: "retried" as const, job: null }));
    const rows = [failedRow(exact), failedRow(missing)];

    const result = await recoverFailedGenerationSourceJobs({
      mode: "image",
      blob: providers.blob,
      cursor: { offset: 0 },
      queue: {
        inspectFailed: async () => rows,
        isPaused: async () => false,
        retry,
      },
    });

    expect(result).toMatchObject({ scanned: 2, recovered: 1 });
    expect(result.invalid).toEqual([{
      bullJobId: rows[1]!.id,
      reason: "terminal_record_missing",
    }]);
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith({
      queue: GEN_QUEUES.imageGenerate,
      dedupeKey: rows[0]!.dedupeKey,
      resetAttemptsMade: true,
    });
  });
});
