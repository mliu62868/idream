import { Worker } from "bullmq";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/server/lib/env";
import { BullMqJobQueue } from "./queue";

// SPEC (docs/research/SERVICE_INTEGRATION.md): async jobs use BullMQ/Redis,
// stable jobId-based dedupe, attempts/backoff, and real worker consumption.

const queue = new BullMqJobQueue();
const Q = "analytics.events";
const testPrefix = "test-m0-queue";

function workerConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== "/"
      ? Number.parseInt(url.pathname.slice(1), 10)
      : 0,
    maxRetriesPerRequest: null,
  };
}

async function clear() {
  await queue.resume([Q]);
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

  it("renews the manual job lock while a real Redis processor exceeds its lease", async () => {
    const shortLeaseQueue = new BullMqJobQueue({
      workerLockDurationMs: 80,
      workerStalledIntervalMs: 40,
      idlePollIntervalMs: 5,
    });
    const dedupeKey = `${testPrefix}-lock-renewal`;
    await shortLeaseQueue.enqueue({
      queue: Q,
      payload: { name: "slow" },
      dedupeKey,
    });

    const result = await shortLeaseQueue.processNext({
      queue: Q,
      workerId: "slow-real-redis",
      processor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 240));
      },
    });

    expect(result).toMatchObject({ status: "completed" });
    await expect(shortLeaseQueue.getByDedupeKey(Q, dedupeKey)).resolves
      .toMatchObject({ state: "completed" });
  });

  it("recovers a real Redis job after a manual worker crashes and its lock expires", async () => {
    const shortLeaseQueue = new BullMqJobQueue({
      workerLockDurationMs: 80,
      workerStalledIntervalMs: 40,
      idlePollIntervalMs: 5,
    });
    const dedupeKey = `${testPrefix}-crash-recovery`;
    const queued = await shortLeaseQueue.enqueue({
      queue: Q,
      payload: { name: "recover-after-crash" },
      dedupeKey,
    });
    const crashedWorker = new Worker(
      Q,
      null,
      {
        autorun: false,
        connection: workerConnection(),
        prefix: env.BULLMQ_PREFIX,
        lockDuration: 80,
        stalledInterval: 40,
      },
    );
    crashedWorker.on("error", () => undefined);
    const token = `crashed-${Date.now()}`;
    try {
      const claimed = await crashedWorker.getNextJob(token, { block: false });
      expect(claimed?.id).toBe(queued.id);
      await expect(claimed?.getState()).resolves.toBe("active");
    } finally {
      await crashedWorker.close(true);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const seen: unknown[] = [];
    const recovered = await shortLeaseQueue.processNext({
      queue: Q,
      workerId: "stalled-recovery",
      idleTimeoutMs: 400,
      processor: async (job) => {
        seen.push(job.payload);
      },
    });

    expect(recovered).toMatchObject({ status: "completed" });
    expect(seen).toEqual([{ name: "recover-after-crash" }]);
    await expect(shortLeaseQueue.inspectInFlight([Q])).resolves.toEqual([]);
    await expect(shortLeaseQueue.getByDedupeKey(Q, dedupeKey)).resolves
      .toMatchObject({ state: "completed" });
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

  it("inspects and exactly redrives an exhausted failed job", async () => {
    const dedupeKey = `${testPrefix}-failed-redrive`;
    await queue.enqueue({
      queue: Q,
      payload: { name: "recover-me" },
      maxAttempts: 1,
      dedupeKey,
    });
    await queue.processNext({
      queue: Q,
      workerId: "failed-redrive-1",
      processor: async () => {
        throw new Error("exhausted");
      },
    });

    await expect(queue.inspectInFlight([Q])).resolves.toEqual([]);
    await expect(queue.inspectFailed([Q])).resolves.toEqual([
      expect.objectContaining({
        dedupeKey,
        state: "failed",
        attemptsMade: 1,
        failedReason: "exhausted",
      }),
    ]);
    await expect(queue.retryFailedByDedupeKey({
      queue: Q,
      dedupeKey,
      resetAttemptsMade: true,
    })).resolves.toMatchObject({
      status: "retried",
      job: { state: "waiting", attemptsMade: 0 },
    });
  });

  it("moves exact failed evidence back to paused waiting without executing it", async () => {
    const dedupeKey = `${testPrefix}-failed-paused`;
    await queue.enqueue({ queue: Q, payload: {}, maxAttempts: 1, dedupeKey });
    await queue.processNext({
      queue: Q,
      workerId: "failed-paused-1",
      processor: async () => {
        throw new Error("pause before redrive");
      },
    });
    await queue.pause([Q]);

    await expect(queue.retryFailedByDedupeKey({
      queue: Q,
      dedupeKey,
      resetAttemptsMade: true,
    })).resolves.toMatchObject({
      status: "retried_paused",
      job: { state: "waiting", attemptsMade: 0 },
    });
    await expect(queue.inspectFailed([Q])).resolves.toHaveLength(0);
    await expect(queue.inspectInFlight([Q])).resolves.toEqual([
      expect.objectContaining({ dedupeKey, state: "waiting", attemptsMade: 0 }),
    ]);
  });

  it("removes jobs by dedupe key prefix", async () => {
    await queue.enqueue({
      queue: Q,
      payload: { name: "remove-me" },
      dedupeKey: `${testPrefix}-remove-1`,
    });
    await queue.enqueue({
      queue: Q,
      payload: { name: "keep-me" },
      dedupeKey: `${testPrefix}-keep-1`,
    });

    const removed = await queue.removeByDedupePrefix(`${testPrefix}-remove`, [Q]);

    expect(removed).toBe(1);
    expect(await queue.getByDedupeKey(Q, `${testPrefix}-remove-1`)).toBeNull();
    expect(await queue.getByDedupeKey(Q, `${testPrefix}-keep-1`)).not.toBeNull();
  });

  it("inspects in-flight rows without claiming or mutating them", async () => {
    const dedupeKey = `${testPrefix}-inspect`;
    const queued = await queue.enqueue({
      queue: Q,
      payload: { name: "inspect-me" },
      dedupeKey,
    });

    await expect(queue.inspectInFlight([Q])).resolves.toEqual([
      expect.objectContaining({
        id: queued.id,
        queue: Q,
        payload: { name: "inspect-me" },
        dedupeKey,
        state: "waiting",
      }),
    ]);
    await expect(queue.getByDedupeKey(Q, dedupeKey)).resolves.toMatchObject({
      id: queued.id,
      state: "waiting",
    });
  });

  it("globally pauses and resumes queue admission", async () => {
    await queue.pause([Q]);
    await expect(queue.inspectPaused([Q])).resolves.toEqual([
      { queue: Q, paused: true },
    ]);
    const queued = await queue.enqueue({
      queue: Q,
      payload: { name: "paused-work" },
      dedupeKey: `${testPrefix}-paused`,
    });
    await expect(queue.inspectInFlight([Q])).resolves.toEqual([
      expect.objectContaining({ id: queued.id, state: "waiting" }),
    ]);

    await queue.resume([Q]);
    await expect(queue.inspectPaused([Q])).resolves.toEqual([
      { queue: Q, paused: false },
    ]);
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
