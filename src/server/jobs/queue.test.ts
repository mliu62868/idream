import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { DbJobQueue } from "./queue";

// SPEC (docs/architecture/11-testing.md §4 — async/queue):
// - enqueue → claim → complete / fail / retry / dead state flow
// - dedupeKey prevents duplicate enqueue; handlers are re-entrant
// - claim orders by priority then age and never double-claims a running job
//
// Isolation: tests use the "analytics.events" queue, which the service never
// enqueues to (trackEvent writes the analytics_events table directly), and
// scope every claim to it — so jobs left queued by other test files can't leak in.

const queue = new DbJobQueue();
const Q = "analytics.events";
const testPrefix = "test-m0-queue";

async function clear() {
  await prisma.job.deleteMany({ where: { queue: Q } });
}

describe("DbJobQueue", () => {
  beforeEach(clear);

  afterAll(async () => {
    await clear();
    await prisma.$disconnect();
  });

  it("dedupes, claims, completes, and records failures", async () => {
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

    const claimed = await queue.claim({ limit: 5, workerId: "vitest", queues: [Q] });
    expect(claimed.map((item) => item.id)).toContain(job.id);

    const completed = await queue.complete(job.id);
    expect(completed.status).toBe("completed");

    const failingJob = await queue.enqueue({
      queue: Q,
      payload: { name: "fail" },
      dedupeKey: `${testPrefix}-fail`,
      maxAttempts: 1,
    });
    const failed = await queue.fail(failingJob.id, "boom");
    expect(failed.status).toBe("dead");
    expect(failed.lastError).toBe("boom");
  });

  it("claims in priority order, then by age", async () => {
    const low = await queue.enqueue({ queue: Q, payload: {}, priority: 9 });
    const high = await queue.enqueue({ queue: Q, payload: {}, priority: 1 });

    const first = await queue.claim({ limit: 1, workerId: "w1", queues: [Q] });
    expect(first.map((j) => j.id)).toEqual([high.id]);

    const second = await queue.claim({ limit: 1, workerId: "w2", queues: [Q] });
    expect(second.map((j) => j.id)).toEqual([low.id]);
  });

  it("marks a job failed with backoff before max attempts (retry-eligible)", async () => {
    const job = await queue.enqueue({
      queue: Q,
      payload: {},
      maxAttempts: 3,
      dedupeKey: `${testPrefix}-retry`,
    });
    const failed = await queue.fail(job.id, new Error("transient"));
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("transient");
    // Backed off into the future, so it is not immediately reclaimable.
    expect(failed.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not double-claim a running job (re-entrancy safe)", async () => {
    const job = await queue.enqueue({ queue: Q, payload: {}, dedupeKey: `${testPrefix}-once` });
    const first = await queue.claim({ limit: 5, workerId: "w1", queues: [Q] });
    expect(first.map((j) => j.id)).toContain(job.id);

    const second = await queue.claim({ limit: 5, workerId: "w2", queues: [Q] });
    expect(second.map((j) => j.id)).not.toContain(job.id);
  });
});
