import { afterAll, beforeEach, expect, it, vi } from "vitest";

// Real Redis and real BullMQ; only construction is counted.
const counts = vi.hoisted(() => ({ constructed: [] as string[], closed: 0 }));
vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  class CountingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      counts.constructed.push(String(args[0]));
    }
    override async close(force?: boolean) {
      if (!this.closing) counts.closed += 1;
      return super.close(force);
    }
  }
  return { ...actual, Worker: CountingWorker };
});

import { BullMqJobQueue } from "./queue";

const QUEUES = ["analytics.events", "app.ai.finalize"];
const queue = new BullMqJobQueue({ idlePollIntervalMs: 5 });

beforeEach(async () => {
  await queue.close();
  counts.constructed.length = 0;
  counts.closed = 0;
  for (const name of QUEUES) await queue.obliterate(name);
});
afterAll(async () => {
  await queue.close();
  for (const name of QUEUES) await queue.obliterate(name);
});

const idle = (name: string) => queue.processNext({ queue: name, workerId: "idle", processor: async () => {} });

it("keeps one Worker per queue across idle polls, the churn an idle finalizer paid every second", async () => {
  for (let index = 0; index < 20; index += 1) {
    await expect(idle(QUEUES[index % 2]!)).resolves.toEqual({ job: null, status: "empty" });
  }
  expect(counts.constructed.sort()).toEqual([...QUEUES].sort());
  expect(counts.closed).toBe(0);
});

it("shares one Worker between concurrent calls, each owning its job through its own token", async () => {
  const name = QUEUES[0]!;
  await queue.enqueue({ queue: name, payload: { key: "a" } });
  await queue.enqueue({ queue: name, payload: { key: "b" } });
  const seen: unknown[] = [];
  const results = await Promise.all(["w1", "w2"].map((workerId) => queue.processNext({
    queue: name,
    workerId,
    processor: async (job) => {
      seen.push(job.payload);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  })));
  expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
  expect(seen).toHaveLength(2);
  expect(new Set(seen.map((payload) => JSON.stringify(payload))).size).toBe(2);
  expect(counts.constructed).toEqual([name]);
});

it("close waits for a claimed job to finish, closes the Worker, and a later call reopens it", async () => {
  const name = QUEUES[0]!;
  await queue.enqueue({ queue: name, payload: {}, dedupeKey: "worker-reuse-close" });
  let release!: () => void;
  let claimed!: () => void;
  const hasClaim = new Promise<void>((resolve) => { claimed = resolve; });
  const processing = queue.processNext({
    queue: name,
    workerId: "slow",
    processor: () => new Promise<void>((resolve) => { release = resolve; claimed(); }),
  });
  await hasClaim;
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(closed).toBe(false);
  release();
  await closing;
  await expect(processing).resolves.toMatchObject({ status: "completed" });
  expect(counts.closed).toBe(1);
  await expect(queue.getByDedupeKey(name, "worker-reuse-close")).resolves.toMatchObject({ state: "completed" });
  await expect(idle(name)).resolves.toMatchObject({ status: "empty" });
  expect(counts.constructed).toEqual([name, name]);
});

it("recovers a job stalled by another worker on the long-lived Worker's own timer, without a new call starting it", async () => {
  const name = QUEUES[0]!;
  const shortLease = new BullMqJobQueue({ workerLockDurationMs: 80, workerStalledIntervalMs: 40, idlePollIntervalMs: 5 });
  try {
    await shortLease.processNext({ queue: name, workerId: "warm", processor: async () => {} });
    const queued = await shortLease.enqueue({ queue: name, payload: { name: "stalled" }, dedupeKey: "worker-reuse-stalled" });
    const { Worker } = await import("bullmq");
    const { env } = await import("@/server/lib/env");
    const { redisConnectionOptions } = await import("@idream/shared/env");
    const crashed = new Worker(name, null, { autorun: false, connection: redisConnectionOptions(env.REDIS_URL), prefix: env.BULLMQ_PREFIX, lockDuration: 80 });
    crashed.on("error", () => undefined);
    expect((await crashed.getNextJob("crashed-token", { block: false }))?.id).toBe(queued.id);
    await crashed.close(true);
    await vi.waitFor(async () => {
      expect((await shortLease.getByDedupeKey(name, "worker-reuse-stalled"))?.state).toBe("waiting");
    }, { timeout: 2_000, interval: 20 });
  } finally {
    await shortLease.close();
  }
});
