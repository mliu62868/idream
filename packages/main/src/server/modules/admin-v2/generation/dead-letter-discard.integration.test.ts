import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { createUser, dreamcoinBalance, purgeTestData } from "@/server/test/helpers";
import { adminV2 } from "@/server/test/admin-v2-http";

const prefix = `zt-discard-lock-${randomUUID()}-`;
const adminId = `${prefix}admin`;
const admin = { userId: adminId, role: "admin" };

beforeAll(() => createUser({ id: adminId, role: "admin", dataClass: "internal" }));
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function debitedJobs(users: readonly string[], ids: readonly string[]) {
  const owners = [...new Set(users)];
  for (const userId of owners) await createUser({ id: userId, dataClass: "customer" });
  for (const [index, id] of ids.entries()) {
    await prisma.generationJob.create({ data: {
      id, userId: users[index], mode: "image", provider: "mock", status: "failed",
      controls: {}, presetIds: [], costDreamcoins: 5, errorCode: "provider_error",
    } });
    await prisma.generationAttempt.create({ data: {
      id: `${id}-attempt`, requestId: id, attemptNo: 1, provider: "mock", status: "failed",
      retryability: "operator_retry", finishedAt: new Date(),
    } });
  }
  await prisma.$transaction(async tx => {
    for (const userId of owners) await postDreamcoinEntry(tx, {
      kind: "signup_bonus", userId, amount: 20, sourceId: `${userId}-bonus`, idempotencyKey: `${userId}:bonus`,
    });
    for (const [index, id] of ids.entries()) await postDreamcoinEntry(tx, {
      kind: "generation_spend", userId: users[index], amount: 5, sourceId: id, idempotencyKey: `generation:${id}:reserve`,
    });
  });
}

function discardBatch(jobIds: string[]) {
  return adminV2("POST", "/api/v2/admin/generation/dead-letter/commands/discard", {
    ...admin, body: { jobIds, confirmation: jobIds.join(","), reason: "Controlled discard regression" },
  });
}

// Queries and SERIALIZABLE retry policy stay real. The hook controls only when
// the first wallet lock executes and the legal, unspecified findMany row order.
function interceptFirstUserLock(
  hook: (input: { index: number; tx: Prisma.TransactionClient; proceed: () => Promise<unknown> }) => Promise<unknown>,
  jobOrders: string[][] = [],
) {
  const transaction = prisma.$transaction.bind(prisma);
  let transactionCount = 0;
  vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
    const [callback, options] = args;
    if (typeof callback !== "function") return Reflect.apply(transaction, prisma, args);
    const index = transactionCount++;
    return transaction(async tx => {
      let firstUserLock = true;
      return callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "generationJob" && jobOrders[index]) {
            return new Proxy(target.generationJob, {
              get(delegate, method, delegateReceiver) {
                if (method !== "findMany") return Reflect.get(delegate, method, delegateReceiver);
                return async (...queryArgs: unknown[]) => {
                  const rows = await Reflect.apply(delegate.findMany, delegate, queryArgs);
                  const order = jobOrders[index];
                  return [...rows].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
                };
              },
            });
          }
          if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
          return async (...queryArgs: unknown[]) => {
            const sql = Array.isArray(queryArgs[0]) ? queryArgs[0].join("") : String(queryArgs[0]);
            const proceed = () => Reflect.apply(target.$queryRaw, target, queryArgs);
            if (!firstUserLock || !sql.includes('"users"') || !sql.includes("FOR UPDATE")) return proceed();
            firstUserLock = false;
            return hook({ index, tx, proceed });
          };
        },
      }));
    }, options as Parameters<typeof prisma.$transaction>[1]);
  }) as typeof prisma.$transaction);
}

async function waitUntilAcquiredOrBlocked(input: { pid: number; blockerPid: number; acquired: () => boolean }) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (input.acquired()) return;
    const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE pid = ${input.pid} AND ${input.blockerPid} = ANY(pg_blocking_pids(pid))
    `;
    if (rows.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Second discard reached neither a held nor a waiting user lock");
}

describe("dead-letter discard settlement", () => {
  it("settles opposite multi-user batches without inverting wallet locks", async () => {
    const userA = `${prefix}batch-a`;
    const userB = `${prefix}batch-b`;
    const ids = ["a1", "b1", "b2", "a2"].map(label => `${prefix}${label}`);
    await debitedJobs([userA, userB, userB, userA], ids);
    const batches = [ids.slice(0, 2), ids.slice(2)];
    let firstHeld = (_pid: number) => {};
    const held = new Promise<number>(resolve => { firstHeld = resolve; });
    let secondStarted = (_pid: number) => {};
    const started = new Promise<number>(resolve => { secondStarted = resolve; });
    let resumeFirst = () => {};
    const firstPause = new Promise<void>(resolve => { resumeFirst = resolve; });
    let resumeSecond = () => {};
    const secondPause = new Promise<void>(resolve => { resumeSecond = resolve; });
    let secondAcquired = false;
    interceptFirstUserLock(async ({ index, tx, proceed }) => {
      if (index > 1) return proceed();
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (index === 1) secondStarted(pid);
      const result = await proceed();
      if (index === 0) {
        firstHeld(pid);
        await firstPause;
      } else {
        secondAcquired = true;
        await secondPause;
      }
      return result;
    }, batches);
    const first = discardBatch(batches[0]);
    let second: ReturnType<typeof discardBatch> | undefined;
    try {
      const blockerPid = await held;
      second = discardBatch(batches[1]);
      await waitUntilAcquiredOrBlocked({ pid: await started, blockerPid, acquired: () => secondAcquired });
    } finally {
      resumeFirst();
      resumeSecond();
    }
    expect(await first).toMatchObject({ status: 200, data: { discarded: expect.arrayContaining(batches[0]), refunded: expect.arrayContaining(batches[0]), skipped: [] } });
    expect(await second).toMatchObject({ status: 200, data: { discarded: expect.arrayContaining(batches[1]), refunded: expect.arrayContaining(batches[1]), skipped: [] } });
    for (const id of ids) expect(await prisma.dreamcoinLedger.count({ where: { sourceId: id, reason: "refund" } })).toBe(1);
    expect(await dreamcoinBalance(userA)).toBe(20);
    expect(await dreamcoinBalance(userB)).toBe(20);
  });

  it.each(["single", "batch"] as const)("keeps a retried Request out of a waiting %s discard", async kind => {
    const userId = `${prefix}retry-${kind}`;
    const jobId = `${prefix}retry-job-${kind}`;
    await debitedJobs([userId], [jobId]);
    let beforeUserLock = () => {};
    const ready = new Promise<void>(resolve => { beforeUserLock = resolve; });
    let resume = () => {};
    const held = new Promise<void>(resolve => { resume = resolve; });
    interceptFirstUserLock(async ({ index, proceed }) => {
      if (index === 0) {
        beforeUserLock();
        await held;
      }
      return proceed();
    });
    const discarded = kind === "batch" ? discardBatch([jobId]) : adminV2("POST",
      `/api/v2/admin/generation/dead-letter/${jobId}/commands/discard`, {
        ...admin, body: { confirmation: jobId, reason: "Controlled pending discard" },
      });
    try {
      await ready;
      const requeued = await adminV2("POST", `/api/v2/admin/generation/dead-letter/${jobId}/commands/requeue`, {
        ...admin, body: { confirmation: jobId, reason: "Operator retry wins before discard" },
      });
      expect(requeued).toMatchObject({ status: 200, data: { queued: true, attemptNo: 2 } });
    } finally {
      resume();
    }
    expect(await discarded).toMatchObject(kind === "batch"
      ? { status: 200, data: { discarded: [], refunded: [], skipped: [{ id: jobId, reason: "not_discardable" }] } }
      : { status: 400, error: { code: "bad_request" } });
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } }))
      .toMatchObject({ status: "queued", errorCode: null });
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: jobId, reason: "refund" } })).toBe(0);
    expect(await prisma.generationJobEvent.count({ where: { jobId, type: "discarded" } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(15);
  });
});
