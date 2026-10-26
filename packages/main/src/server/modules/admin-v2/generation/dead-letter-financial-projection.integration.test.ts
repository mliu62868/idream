import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { refundGenerationRequest } from "@/server/ai/generation-refund";
import { postDreamcoinEntry } from "@/server/modules/billing/ledger";
import { adminV2 } from "@/server/test/admin-v2-http";
import { createUser, dreamcoinBalance, purgeTestData } from "@/server/test/helpers";

const prefix = `zt-dead-letter-money-${randomUUID()}-`;
const adminId = `${prefix}admin`;
const customerId = `${prefix}customer`;
const admin = { userId: adminId, role: "admin" };

beforeAll(async () => {
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createUser({ id: customerId, dataClass: "customer" });
  await prisma.$transaction(tx => postDreamcoinEntry(tx, {
    kind: "signup_bonus", userId: customerId, amount: 100, sourceId: customerId,
    idempotencyKey: `${customerId}:bonus`,
  }));
});

afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

async function failedJob(label: string, charged: boolean) {
  const id = `${prefix}${label}`;
  const userId = charged ? customerId : adminId;
  await prisma.generationJob.create({ data: {
    id, userId, mode: "image", status: "failed", provider: "mock",
    controls: {}, presetIds: [], costDreamcoins: charged ? 5 : 100,
    errorCode: "provider_error", sourceType: charged ? "chat" : "content_production_item",
  } });
  await prisma.generationAttempt.create({ data: {
    id: `${id}-attempt`, requestId: id, attemptNo: 1, provider: "mock",
    status: "failed", retryability: "operator_retry", finishedAt: new Date(),
  } });
  if (charged) await prisma.$transaction(tx => postDreamcoinEntry(tx, {
    kind: "generation_spend", userId, amount: 5, sourceId: id,
    idempotencyKey: `generation:${id}:reserve`,
  }));
  return id;
}

describe("dead-letter financial authority", () => {
  it("distinguishes an uncharged quote, a charged request, and partial/full refunds without writes", async () => {
    const uncharged = await failedJob("uncharged", false);
    const charged = await failedJob("charged", true);
    const partial = await failedJob("partial", true);
    const refunded = await failedJob("refunded", true);
    await prisma.$transaction(async tx => {
      await refundGenerationRequest(tx, { requestId: partial, userId: customerId, cause: { kind: "partial" }, requested: 2 });
      await refundGenerationRequest(tx, { requestId: refunded, userId: customerId, cause: { kind: "operator_manual" }, requested: 5 });
    });
    // A stale timeline event cannot turn an uncharged Admin quote into a refund.
    await prisma.generationJobEvent.create({ data: { jobId: uncharged, type: "refunded", message: "Historical event only", metadata: { amount: 999 } } });
    const ledgerBefore = await prisma.dreamcoinLedger.findMany({ where: { userId: { in: [adminId, customerId] } }, orderBy: { id: "asc" } });
    const linksBefore = await prisma.generationSettlementLink.count({ where: { requestId: { startsWith: prefix } } });
    for (let read = 0; read < 2; read += 1) {
      const result = await adminV2("GET", `/api/v2/admin/generation/dead-letter?search=${prefix}`, admin);
      expect(result.status, JSON.stringify(result.error)).toBe(200);
      const rows = result.data.items as { id: string; costDreamcoins: number; ledgerState: string }[];
      expect.soft(rows.find(row => row.id === uncharged)).toMatchObject({ costDreamcoins: 100, ledgerState: "not_charged" });
      expect.soft(rows.find(row => row.id === charged)).toMatchObject({ costDreamcoins: 5, ledgerState: "reserved" });
      expect.soft(rows.find(row => row.id === partial)).toMatchObject({ ledgerState: "partially_refunded" });
      expect.soft(rows.find(row => row.id === refunded)).toMatchObject({ ledgerState: "refunded" });
    }
    expect(await prisma.dreamcoinLedger.findMany({ where: { userId: { in: [adminId, customerId] } }, orderBy: { id: "asc" } })).toEqual(ledgerBefore);
    expect(await prisma.generationSettlementLink.count({ where: { requestId: { startsWith: prefix } } })).toBe(linksBefore);
  });

  it.each(["single", "batch"] as const)("operator %s retry and replay preserve both the uncharged Admin request and the original customer charge", async kind => {
    const ids = [await failedJob(`${kind}-admin`, false), await failedJob(`${kind}-customer`, true)];
    const before = await prisma.dreamcoinLedger.findMany({ where: { sourceId: { in: ids } }, orderBy: { id: "asc" } });
    const balance = await dreamcoinBalance(customerId);
    const groups = kind === "batch" ? [ids] : ids.map(id => [id]);
    for (const jobIds of groups) {
      const path = kind === "batch"
        ? "/api/v2/admin/generation/dead-letter/commands/requeue"
        : `/api/v2/admin/generation/dead-letter/${jobIds[0]}/commands/requeue`;
      const body = { ...(kind === "batch" ? { jobIds } : {}), confirmation: jobIds.join(","), reason: "Controlled retry billing regression" };
      const options = { ...admin, body, idempotencyKey: `${jobIds[0]}:retry` };
      const first = await adminV2("POST", path, options);
      expect(first.status, JSON.stringify(first.error)).toBe(200);
      const replay = await adminV2("POST", path, options);
      expect(replay.status, JSON.stringify(replay.error)).toBe(200);
      expect(replay.data).toEqual(first.data);
    }
    for (const requestId of ids) expect(await prisma.generationAttempt.count({ where: { requestId } })).toBe(2);
    expect(await prisma.dreamcoinLedger.findMany({ where: { sourceId: { in: ids } }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await dreamcoinBalance(customerId)).toBe(balance);
  });

  it("discard refunds only the remaining charge, never the estimate or an already refunded amount", async () => {
    const uncharged = await failedJob("discard-admin", false);
    const partial = await failedJob("discard-partial", true);
    const refunded = await failedJob("discard-refunded", true);
    await prisma.$transaction(async tx => {
      await refundGenerationRequest(tx, { requestId: partial, userId: customerId, cause: { kind: "partial" }, requested: 2 });
      await refundGenerationRequest(tx, { requestId: refunded, userId: customerId, cause: { kind: "operator_manual" }, requested: 5 });
    });
    const balance = await dreamcoinBalance(customerId);
    const jobIds = [uncharged, partial, refunded];
    const options = { ...admin, body: { jobIds, confirmation: jobIds.join(","), reason: "Controlled discard billing regression" }, idempotencyKey: `${uncharged}:discard` };
    const first = await adminV2("POST", "/api/v2/admin/generation/dead-letter/commands/discard", options);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.data).toMatchObject({ discarded: expect.arrayContaining(jobIds), refunded: [partial], skipped: [] });
    const replay = await adminV2("POST", "/api/v2/admin/generation/dead-letter/commands/discard", options);
    expect(replay.status, JSON.stringify(replay.error)).toBe(200);
    expect(replay.data).toEqual(first.data);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: uncharged } })).toBe(0);
    for (const sourceId of [partial, refunded]) {
      const refunds = await prisma.dreamcoinLedger.aggregate({ where: { sourceId, reason: "refund" }, _sum: { delta: true } });
      expect(refunds._sum.delta).toBe(5);
    }
    expect(await dreamcoinBalance(customerId)).toBe(balance + 3);
  });
});
