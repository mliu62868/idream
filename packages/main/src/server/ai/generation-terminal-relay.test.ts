import {
  generationTerminalRecordChecksum,
  generationTerminalRecordIngestSchema,
  idempotencyKeys,
  MAIN_QUEUES,
} from "@idream/shared/contracts";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { bullMqJobIdForDedupeKey, type QueueJobSnapshot } from "@/server/jobs/queue";
import {
  consumeGenerationTerminalRelay,
  redriveFailedGenerationTerminalRelays,
} from "./generation-terminal-relay";

function relayPayload() {
  const terminalRecord = {
    version: 1 as const,
    outcome: "succeeded" as const,
    attemptId: "relay-attempt-1",
    attemptNo: 1,
    transportAttemptNo: 1,
    providerIdempotencyKey: "generation:relay-attempt-1:provider",
    requestId: "generation_dispatch_relay-attempt-1",
    generationJobId: "relay-job-1",
    mode: "video" as const,
    provider: "comfyui",
    providerInvoked: true,
    model: "ltx23-gtanimation-i2v",
    providerRequestId: "provider-request-1",
    completedAt: "2026-08-02T12:00:00.000Z",
    usage: { gpuSeconds: 12 },
    assets: [{
      ordinal: 0,
      key: "gen/relay-job-1/attempts/relay-attempt-1/video.mp4",
      contentType: "video/mp4",
      providerKey: "provider/video-1",
      seconds: 4,
    }],
  };
  return generationTerminalRecordIngestSchema.parse({
    terminalRecordRef:
      "gen/terminal-records/relay-attempt-1/terminal.json",
    terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
    terminalRecord,
  });
}

describe("generation terminal relay consumer", () => {
  it("validates and forwards the immutable ingest payload", async () => {
    const payload = relayPayload();
    const ingest = vi.fn(async () => ({
      acknowledged: true,
      status: "persisted" as const,
      receiptId: "receipt-1",
    }));

    await expect(consumeGenerationTerminalRelay(payload, ingest)).resolves
      .toMatchObject({ acknowledged: true, status: "persisted" });
    expect(ingest).toHaveBeenCalledWith(payload);
  });

  it("rejects malformed queue evidence before touching ingest authority", async () => {
    const ingest = vi.fn();

    await expect(consumeGenerationTerminalRelay({ attemptId: "missing" }, ingest))
      .rejects.toThrow();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("fails when Main rejects evidence without a durable quarantine receipt", async () => {
    const ingest = vi.fn(async () => ({
      acknowledged: false,
      status: "quarantined" as const,
      receiptId: null,
    }));

    await expect(consumeGenerationTerminalRelay(relayPayload(), ingest))
      .rejects.toThrow("was not durably acknowledged");
  });

  it("completes when Main durably quarantined the immutable evidence", async () => {
    const ingest = vi.fn(async () => ({
      acknowledged: false,
      status: "quarantined" as const,
      receiptId: "quarantine-receipt-1",
    }));

    await expect(consumeGenerationTerminalRelay(relayPayload(), ingest))
      .resolves.toMatchObject({
        acknowledged: false,
        status: "quarantined",
        receiptId: "quarantine-receipt-1",
      });
  });

  it("advances past a full poison page so later exact evidence is not starved", async () => {
    const payload = relayPayload();
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      payload.terminalRecord.attemptId,
    );
    const valid: QueueJobSnapshot = {
      id: bullMqJobIdForDedupeKey(dedupeKey),
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: payload as unknown as Prisma.JsonValue,
      dedupeKey,
      attemptsMade: 1,
      maxAttempts: 1,
      state: "failed",
      timestamp: Date.now(),
    };
    const poison = Array.from({ length: 100 }, (_, index) => ({
      ...valid,
      id: `poison-${index}`,
      payload: { malformed: index },
      dedupeKey: `poison-${index}`,
    }));
    const rows = [...poison, valid];
    const retry = vi.fn(async () => ({ status: "retried" as const, job: valid }));
    const queue = {
      inspectFailed: async (
        _queues: readonly string[],
        options?: { limit?: number; offset?: number },
      ) => rows.slice(
        options?.offset ?? 0,
        (options?.offset ?? 0) + (options?.limit ?? 100),
      ),
      inspectPaused: async () => [{
        queue: MAIN_QUEUES.generationTerminalIngest,
        paused: false,
      }],
      retryFailedByDedupeKey: retry,
    };
    const cursor = { offset: 0 };

    await expect(redriveFailedGenerationTerminalRelays({ queue, cursor }))
      .resolves.toMatchObject({ scanned: 100, redriven: 0 });
    await expect(redriveFailedGenerationTerminalRelays({ queue, cursor }))
      .resolves.toMatchObject({ scanned: 1, redriven: 1 });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("isolates a schema-valid non-generation finalize poison from a valid relay", async () => {
    const payload = relayPayload();
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      payload.terminalRecord.attemptId,
    );
    const valid: QueueJobSnapshot = {
      id: bullMqJobIdForDedupeKey(dedupeKey),
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: payload as unknown as Prisma.JsonValue,
      dedupeKey,
      attemptsMade: 1,
      maxAttempts: 1,
      state: "failed",
      timestamp: Date.now(),
    };
    const poison: QueueJobSnapshot = {
      ...valid,
      id: "chat-finalize-poison",
      queue: MAIN_QUEUES.aiFinalize,
      dedupeKey: "chat-finalize-poison",
      payload: {
        version: 1,
        kind: "chat.completed",
        requestId: "chat-request",
        sessionId: "session-1",
        userMessageId: "user-message-1",
        assistantMessageId: "assistant-message-1",
        content: "done",
        model: "mock",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    };
    const retry = vi.fn(async () => ({ status: "retried" as const, job: valid }));
    const result = await redriveFailedGenerationTerminalRelays({
      cursor: { offset: 0 },
      queue: {
        inspectFailed: async () => [poison, valid],
        retryFailedByDedupeKey: retry,
      },
    });

    expect(result).toMatchObject({ redriven: 1, retryErrors: [] });
    expect(result.invalid).toEqual([{
      bullJobId: poison.id,
      reason: "unsupported_kind",
    }]);
    expect(retry).toHaveBeenCalledOnce();
  });
});
