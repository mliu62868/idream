import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { refundGenerationRequest } from "@/server/ai/generation-refund";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import {
  api,
  createUser,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-generation-read-model-";

async function purgeFixtures() {
  await prisma.generationAttempt.deleteMany({
    where: { requestId: { startsWith: P } },
  });
  await purgeTestData(P);
}

beforeAll(purgeFixtures);

afterAll(async () => {
  await purgeFixtures();
  await prisma.$disconnect();
});

describe("customer generation job read model", () => {
  it("reads actual settlement without treating quotes or refund events as ledger facts", async () => {
    const userId = `${P}settlement-user`;
    const chargedId = `${P}settlement-charged`;
    const unchargedId = `${P}settlement-uncharged`;
    await createUser({ id: userId });
    await prisma.generationJob.createMany({ data: [chargedId, unchargedId].map(id => ({
      id, userId, mode: "image", controls: {}, presetIds: [], status: "failed", costDreamcoins: 40,
    })) });
    await prisma.$transaction(async tx => {
      await postDreamcoinEntry(tx, { kind: "signup_bonus", userId, amount: 100, sourceId: userId, idempotencyKey: `${userId}:bonus` });
      await postDreamcoinEntry(tx, { kind: "generation_spend", userId, amount: 40, sourceId: chargedId, idempotencyKey: `${chargedId}:spend` });
      await refundGenerationRequest(tx, { requestId: chargedId, userId, cause: { kind: "partial" }, requested: 10 });
    });
    // Incident refunds use the same settlement writer without a Job event.
    // Historical or duplicate timeline events are not financial authority.
    await prisma.generationJobEvent.create({ data: { jobId: chargedId, type: "refunded", message: "Historical timeline", metadata: { amount: 999 } } });
    const partial = await api("GET", `generation/jobs/${chargedId}`, { userId, ageGate: true });
    expectOk(partial);
    expect(partial.data.job.costDreamcoins).toBe(40);
    expect.soft(partial.data.cost).toMatchObject({ charged: 40, refunded: 10, finalCharge: 30 });
    expect.soft(partial.data.job.cost).toEqual(partial.data.cost);

    await prisma.$transaction(tx => refundGenerationRequest(tx, { requestId: chargedId, userId, cause: { kind: "incident_action", commandId: `${P}incident` } }));
    const linksBefore = await prisma.generationSettlementLink.count({ where: { requestId: chargedId } });
    const ledgerBefore = await prisma.dreamcoinLedger.count({ where: { userId } });
    for (let index = 0; index < 2; index += 1) {
      const list = await api("GET", "generation/jobs", { userId, ageGate: true, query: { limit: "20" } });
      expectOk(list);
      const items = list.data.items as Array<{ id: string; cost: { charged: number; refunded: number; finalCharge: number } }>;
      expect.soft(items.find(job => job.id === chargedId)?.cost).toMatchObject({ charged: 40, refunded: 40, finalCharge: 0 });
      expect.soft(items.find(job => job.id === unchargedId)?.cost).toMatchObject({ charged: 0, refunded: 0, finalCharge: 0 });
      const detail = await api("GET", `generation/jobs/${chargedId}`, { userId, ageGate: true });
      expectOk(detail);
      expect.soft(detail.data.cost).toMatchObject({ charged: 40, refunded: 40, finalCharge: 0 });
    }
    expect(await prisma.generationSettlementLink.count({ where: { requestId: chargedId } })).toBe(linksBefore);
    expect(await prisma.dreamcoinLedger.count({ where: { userId } })).toBe(ledgerBefore);
  });

  it("projects the latest running Attempt while preserving queued and terminal Job states", async () => {
    const userId = `${P}user`;
    const createdAt = new Date("2026-08-11T16:06:30.000Z");
    const now = new Date("2026-08-11T16:06:31.798Z");
    const jobIds = {
      queued: `${P}queued`,
      retry: `${P}retry`,
      completed: `${P}completed`,
      failed: `${P}failed`,
      cancelled: `${P}cancelled`,
    } as const;
    await createUser({ id: userId });
    await prisma.generationJob.createMany({
      data: [
        {
          id: jobIds.queued,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "queued",
          createdAt,
        },
        {
          id: jobIds.retry,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "queued",
          createdAt,
        },
        {
          id: jobIds.completed,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "completed",
          completedAt: now,
          finishedAt: now,
          createdAt,
        },
        {
          id: jobIds.failed,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "failed",
          errorCode: "provider_failed",
          finishedAt: now,
          createdAt,
        },
        {
          id: jobIds.cancelled,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          status: "cancelled",
          finishedAt: now,
          createdAt,
        },
      ],
    });
    await prisma.generationAttempt.createMany({
      data: [
        {
          id: `${P}attempt-queued`,
          requestId: jobIds.queued,
          attemptNo: 1,
          status: "queued",
          createdAt,
        },
        {
          id: `${P}attempt-stale-running`,
          requestId: jobIds.retry,
          attemptNo: 1,
          status: "running",
          startedAt: now,
          createdAt,
        },
        {
          id: `${P}attempt-latest-queued`,
          requestId: jobIds.retry,
          attemptNo: 2,
          status: "queued",
          createdAt,
        },
        // A stale running Attempt must never revive a terminal Job.
        ...(["completed", "failed", "cancelled"] as const).map((state) => ({
          id: `${P}attempt-${state}`,
          requestId: jobIds[state],
          attemptNo: 1,
          status: "running",
          startedAt: now,
          createdAt,
        })),
      ],
    });

    const list = await api("GET", "generation/jobs", {
      userId,
      ageGate: true,
      query: { limit: "20" },
    });
    expectOk(list);
    const listedStatuses = Object.fromEntries(
      (list.data.items as Array<{ id: string; status: string }>).map((job) => [
        job.id,
        job.status,
      ]),
    );
    expect(listedStatuses).toMatchObject({
      [jobIds.queued]: "queued",
      [jobIds.retry]: "queued",
      [jobIds.completed]: "completed",
      [jobIds.failed]: "failed",
      [jobIds.cancelled]: "cancelled",
    });

    for (const [state, jobId] of Object.entries(jobIds)) {
      const detail = await api("GET", `generation/jobs/${jobId}`, {
        userId,
        ageGate: true,
      });
      expectOk(detail);
      expect(detail.data.job.status, state).toBe(state === "retry" ? "queued" : state);
    }

    await prisma.generationAttempt.update({
      where: { id: `${P}attempt-latest-queued` },
      data: { status: "running", startedAt: now },
    });
    const refreshedList = await api("GET", "generation/jobs", {
      userId,
      ageGate: true,
      query: { limit: "20" },
    });
    expectOk(refreshedList);
    expect(
      (refreshedList.data.items as Array<{ id: string; status: string }>).find(
        (job) => job.id === jobIds.retry,
      )?.status,
    ).toBe("running");
    const runningPoll = await api("GET", `generation/jobs/${jobIds.retry}`, {
      userId,
      ageGate: true,
    });
    expectOk(runningPoll);
    expect(runningPoll.data.job.status).toBe("running");
  });
});
