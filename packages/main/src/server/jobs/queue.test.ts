import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BullMqJobQueue } from "./queue";

// SPEC (docs/research/SERVICE_INTEGRATION.md): async jobs use BullMQ/Redis,
// stable jobId-based dedupe, attempts/backoff, and real worker consumption.

const queue = new BullMqJobQueue();
const Q = "analytics.events";
const testPrefix = "test-m0-queue";

async function clear() {
  await queue.obliterate(Q);
}

describe("BullMqJobQueue", () => {
  beforeEach(clear);

  afterAll(async () => {
    await clear();
  });

  it("dedupes by stable dedupeKey and processes a job with a BullMQ worker", async () => {
    const job = await queue.enqueue({
      queue: Q,
      payload: { name: "test" },
      dedupeKey: `${testPrefix}-dedupe`,
    });
    const deduped = await queue.enqueue({
      queue: Q,
      payload: { name: "test-updated" },
      dedupeKey: `${testPrefix}-dedupe`,
    });

    expect(deduped.id).toBe(job.id);

    const seen: unknown[] = [];
    const result = await queue.processNext({
      queue: Q,
      workerId: "vitest",
      processor: async (claimed) => {
        seen.push(claimed.payload);
      },
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(result.job?.id).toBe(job.id);
    expect(seen).toEqual([{ name: "test" }]);

    const snapshot = await queue.getByDedupeKey(Q, `${testPrefix}-dedupe`);
    expect(snapshot?.state).toBe("completed");
  });

  it("processes in priority order", async () => {
    const low = await queue.enqueue({ queue: Q, payload: { key: "low" }, priority: 9 });
    const high = await queue.enqueue({ queue: Q, payload: { key: "high" }, priority: 1 });

    const first = await queue.processNext({
      queue: Q,
      workerId: "w1",
      processor: async () => {},
    });
    expect(first.job?.id).toBe(high.id);

    const second = await queue.processNext({
      queue: Q,
      workerId: "w2",
      processor: async () => {},
    });
    expect(second.job?.id).toBe(low.id);
  });

  it("keeps a retryable failed job in BullMQ failed/delayed state", async () => {
    const job = await queue.enqueue({
      queue: Q,
      payload: {},
      maxAttempts: 3,
      dedupeKey: `${testPrefix}-retry`,
    });

    const failed = await queue.processNext({
      queue: Q,
      workerId: "w-retry",
      processor: async () => {
        throw new Error("transient");
      },
    });

    expect(failed).toMatchObject({ status: "failed", error: "transient" });
    expect(failed.job?.id).toBe(job.id);
    const snapshot = await queue.getByDedupeKey(Q, `${testPrefix}-retry`);
    expect(["failed", "delayed", "waiting"]).toContain(snapshot?.state);
    expect(snapshot?.failedReason).toBe("transient");
  });

  it("returns empty when no job is waiting", async () => {
    const result = await queue.processNext({
      queue: Q,
      workerId: "empty",
      idleTimeoutMs: 50,
      processor: async () => {},
    });
    expect(result).toEqual({ job: null, status: "empty" });
  });
});
