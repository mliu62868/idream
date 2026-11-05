import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { createUser, purgeTestData } from "@/server/test/helpers";
import { dispatchStaleUnknownGenerationRequests } from "./stale-unknown-dispatcher";

const reconcile = vi.hoisted(() => vi.fn().mockResolvedValue({ resolution: "confirm_failed", refundAmount: 0 }));
vi.mock("./unknown-reconciliation", () => ({ reconcileUnknownGenerationRequest: reconcile }));

const prefix = `zt-unknown-page-${randomUUID()}-`;
const userId = `${prefix}user`;
const eligibleId = `${prefix}eligible`;
const laterEligibleId = `${prefix}later-eligible`;
const supersededId = `${prefix}superseded`;
const now = new Date("2001-01-01T00:00:00Z");

beforeAll(async () => {
  await createUser({ id: userId, dataClass: "internal" });
  const closed = Array.from({ length: 60 }, (_, i) => ({ id: `${prefix}closed-${i}`, status: "failed" }));
  await prisma.generationJob.createMany({ data: [
    ...closed, { id: supersededId, status: "running" }, { id: eligibleId, status: "running" }, { id: laterEligibleId, status: "running" },
  ].map(({ id, status }) => ({ id, userId, mode: "image", status, controls: {}, presetIds: [] })) });
  await prisma.generationAttempt.createMany({ data: [
    ...closed.map(({ id }) => ({ id: `${id}-attempt`, requestId: id, attemptNo: 1, status: "unknown", finishedAt: new Date("1999-01-01Z") })),
    { id: `${supersededId}-old`, requestId: supersededId, attemptNo: 1, status: "unknown", finishedAt: new Date("1999-01-01Z") },
    { id: `${supersededId}-current`, requestId: supersededId, attemptNo: 2, status: "running", finishedAt: null },
    { id: `${eligibleId}-attempt`, requestId: eligibleId, attemptNo: 1, status: "unknown", finishedAt: new Date("2000-01-01Z") },
    { id: `${laterEligibleId}-attempt`, requestId: laterEligibleId, attemptNo: 1, status: "unknown", finishedAt: new Date("2000-06-01Z") },
  ] });
});

afterAll(async () => {
  await prisma.generationAttempt.deleteMany({ where: { requestId: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

describe("stale unknown candidate pagination", () => {
  it("filters settled and superseded history before limiting the oldest eligible page", async () => {
    const result = await dispatchStaleUnknownGenerationRequests(prisma, { now, limit: 1, graceMs: 0 });
    expect(result).toMatchObject({ examined: 1, settled: 1, refunded: 0, skipped: 0 });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: eligibleId }));
    expect(await prisma.generationAttempt.count({ where: { requestId: { startsWith: prefix }, status: "unknown" } })).toBe(63);
  });

  it("moves past rows that stay eligible, then starts over at the end", async () => {
    reconcile.mockClear();
    const first = await dispatchStaleUnknownGenerationRequests(prisma, { now, limit: 1, graceMs: 0 });
    expect(first.nextCursor).toEqual({ finishedAt: new Date("2000-01-01Z"), id: `${eligibleId}-attempt` });
    const second = await dispatchStaleUnknownGenerationRequests(prisma, { now, limit: 1, graceMs: 0, cursor: first.nextCursor });
    expect(reconcile.mock.calls.map(([call]) => call.requestId)).toEqual([eligibleId, laterEligibleId]);
    const end = await dispatchStaleUnknownGenerationRequests(prisma, { now, limit: 1, graceMs: 0, cursor: second.nextCursor });
    expect(end).toMatchObject({ examined: 0, nextCursor: null });
  });
});
