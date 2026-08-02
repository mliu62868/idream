import {
  generationTerminalRecordChecksum,
  idempotencyKeys,
  MAIN_QUEUES,
} from "@idream/shared/contracts";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BullMqJobQueue,
  jobQueue,
} from "@/server/jobs/queue";
import { drainLocalAiPipeline } from "./local-pipeline";
import {
  consumeGenerationTerminalRelay,
  redriveFailedGenerationTerminalRelays,
} from "./generation-terminal-relay";

const ingestGenerationTerminalRecord = vi.hoisted(() => vi.fn());

vi.mock("./generation-terminal-record-ingest", () => ({
  ingestGenerationTerminalRecord,
}));

function relayPayload() {
  const terminalRecord = {
    version: 1 as const,
    outcome: "succeeded" as const,
    attemptId: "relay-restart-attempt-1",
    attemptNo: 1,
    transportAttemptNo: 1,
    providerIdempotencyKey: "generation:relay-restart-attempt-1:provider",
    requestId: "generation_dispatch_relay-restart-attempt-1",
    generationJobId: "relay-restart-job-1",
    mode: "video" as const,
    provider: "comfyui",
    providerInvoked: true,
    model: "ltx23-gtanimation-i2v",
    providerRequestId: "provider-request-restart-1",
    completedAt: "2026-08-02T12:00:00.000Z",
    usage: { gpuSeconds: 12 },
    assets: [{
      ordinal: 0,
      key:
        "gen/relay-restart-job-1/attempts/relay-restart-attempt-1/video.mp4",
      contentType: "video/mp4",
      providerKey: "provider/video-restart-1",
      seconds: 4,
    }],
  };
  return {
    terminalRecordRef:
      "gen/terminal-records/relay-restart-attempt-1/terminal.json",
    terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
    terminalRecord,
  };
}

async function clearRelayQueue() {
  await jobQueue.resume([MAIN_QUEUES.generationTerminalIngest]);
  await jobQueue.obliterate(MAIN_QUEUES.generationTerminalIngest);
}

beforeEach(async () => {
  ingestGenerationTerminalRecord.mockReset();
  await clearRelayQueue();
});

afterAll(clearRelayQueue);

describe("generation terminal relay durability", () => {
  it("survives transient Main failure and a finalizer consumer restart", async () => {
    const payload = relayPayload();
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      payload.terminalRecord.attemptId,
    );
    ingestGenerationTerminalRecord
      .mockRejectedValueOnce(new Error("Main database temporarily unavailable"))
      .mockResolvedValue({
        acknowledged: true,
        status: "persisted",
        receiptId: "receipt-after-restart",
      });
    await jobQueue.enqueue({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload,
      dedupeKey,
      maxAttempts: 1,
    });

    await expect(drainLocalAiPipeline({
      queues: [MAIN_QUEUES.generationTerminalIngest],
      limit: 1,
      workerId: "finalizer-before-restart",
    })).resolves.toMatchObject({
      processed: 0,
      claimed: [expect.objectContaining({
        status: "failed",
        error: "Main database temporarily unavailable",
      })],
    });
    await expect(jobQueue.getByDedupeKey(
      MAIN_QUEUES.generationTerminalIngest,
      dedupeKey,
    )).resolves.toMatchObject({ state: "failed", attemptsMade: 1 });

    // A new scanner client models gen-finalizer restarting after the relay
    // exhausted its own retry budget.
    const restartedFinalizerQueue = new BullMqJobQueue();
    await expect(redriveFailedGenerationTerminalRelays({
      queue: restartedFinalizerQueue,
    })).resolves.toEqual({
      scanned: 1,
      redriven: 1,
      deferredPaused: 0,
      invalid: [],
      retryErrors: [],
    });
    await expect(restartedFinalizerQueue.getByDedupeKey(
      MAIN_QUEUES.generationTerminalIngest,
      dedupeKey,
    )).resolves.toMatchObject({ state: "waiting", attemptsMade: 0 });

    await expect(restartedFinalizerQueue.processNext({
      queue: MAIN_QUEUES.generationTerminalIngest,
      workerId: "finalizer-after-restart",
      processor: async (job) => {
        await consumeGenerationTerminalRelay(job.payload);
      },
    })).resolves.toMatchObject({ status: "completed" });

    expect(ingestGenerationTerminalRecord).toHaveBeenCalledTimes(2);
    expect(ingestGenerationTerminalRecord).toHaveBeenNthCalledWith(1, payload);
    expect(ingestGenerationTerminalRecord).toHaveBeenNthCalledWith(2, payload);
    await expect(restartedFinalizerQueue.getByDedupeKey(
      MAIN_QUEUES.generationTerminalIngest,
      dedupeKey,
    )).resolves.toMatchObject({ state: "completed", attemptsMade: 1 });
  });

  it("keeps checksum-mismatched poison evidence failed and visible", async () => {
    const payload = {
      ...relayPayload(),
      terminalRecordChecksum: "f".repeat(64),
    };
    const dedupeKey = idempotencyKeys.generationTerminalRelay(
      payload.terminalRecord.attemptId,
    );
    ingestGenerationTerminalRecord.mockResolvedValue({
      acknowledged: false,
      status: "quarantined",
      receiptId: null,
    });
    await jobQueue.enqueue({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload,
      dedupeKey,
      maxAttempts: 1,
    });

    await expect(drainLocalAiPipeline({
      queues: [MAIN_QUEUES.generationTerminalIngest],
      limit: 1,
      workerId: "checksum-mismatch-finalizer",
    })).resolves.toMatchObject({
      processed: 0,
      claimed: [expect.objectContaining({ status: "failed" })],
    });
    const restartedFinalizerQueue = new BullMqJobQueue();
    await expect(redriveFailedGenerationTerminalRelays({
      queue: restartedFinalizerQueue,
    })).resolves.toEqual({
      scanned: 1,
      redriven: 0,
      deferredPaused: 0,
      invalid: [{
        bullJobId: expect.any(String),
        reason: "checksum_mismatch",
      }],
      retryErrors: [],
    });
    await expect(restartedFinalizerQueue.getByDedupeKey(
      MAIN_QUEUES.generationTerminalIngest,
      dedupeKey,
    )).resolves.toMatchObject({ state: "failed", attemptsMade: 1 });
  });
});
