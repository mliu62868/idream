import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as adjustmentRoute } from "@/app/api/v2/admin/billing/adjustments/route";
import { prisma } from "@/server/lib/db";
import {
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";
import { adminV2Route } from "@/server/test/admin-v2-route-client";

const P = "zt-adminv2-billing-adjust-";
const adminId = `${P}admin`;
const supportId = `${P}support`;
const targetId = `${P}target`;

function adjust(options: {
  userId: string;
  role: string;
  body: Record<string, unknown>;
  idempotencyKey?: string | false;
}) {
  return adminV2Route(adjustmentRoute, {
    method: "POST",
    path: "billing/adjustments",
    userId: options.userId,
    role: options.role,
    idempotencyKey: options.idempotencyKey,
    body: options.body,
  });
}

async function cleanup() {
  await prisma.controlPlaneCommand.deleteMany({
    where: { actorId: { startsWith: P } },
  });
  await purgeTestData(P);
}

beforeAll(async () => {
  await cleanup();
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createUser({ id: supportId, role: "support", dataClass: "internal" });
  await createUser({ id: targetId });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe.sequential("Admin v2 ledger adjustment", () => {
  it("gates the adjustment behind billing.ledger.adjust", async () => {
    expectError(
      await adjust({
        userId: supportId,
        role: "support",
        body: { userId: targetId, delta: 1, reason: "noop baseline", confirmation: `${targetId}:1` },
      }),
      403,
    );
  });

  it("requires an Idempotency-Key header", async () => {
    expectError(
      await adjust({
        userId: adminId,
        role: "admin",
        idempotencyKey: false,
        body: { userId: targetId, delta: 42, reason: "missing key", confirmation: `${targetId}:42` },
      }),
      400,
      "bad_request",
    );
  });

  it("rejects a confirmation that does not name the user and signed delta", async () => {
    expectError(
      await adjust({
        userId: adminId,
        role: "admin",
        body: { userId: targetId, delta: 42, reason: "wrong adjustment confirmation", confirmation: "ADJUST" },
      }),
      400,
      "bad_request",
    );
    expect(await dreamcoinBalance(targetId)).toBe(0);
  });

  it("posts one append-only entry, replays the same key, and rejects a different intent", async () => {
    const idempotencyKey = `${P}idempotency`;
    const first = await adjust({
      userId: adminId,
      role: "admin",
      idempotencyKey,
      body: { userId: targetId, delta: 42, reason: "support credit", confirmation: `${targetId}:42` },
    });
    expectOk(first);
    expect(await dreamcoinBalance(targetId)).toBe(42);
    expect(first.data).toMatchObject({
      replayed: false,
      ledgerEntry: { userId: targetId, delta: 42, balanceAfter: 42, reason: "admin_adjust" },
    });

    // INVARIANT: 幂等判等看的是账本的 canonical intent，不是整个请求体 —— 只改 reason
    // 措辞的重放仍是重放，金额只记一次。
    const replay = await adjust({
      userId: adminId,
      role: "admin",
      idempotencyKey,
      body: { userId: targetId, delta: 42, reason: "support credit replay", confirmation: `${targetId}:42` },
    });
    expectOk(replay);
    expect(replay.data.replayed).toBe(true);
    expect(await dreamcoinBalance(targetId)).toBe(42);
    await expect(
      prisma.dreamcoinLedger.count({ where: { idempotencyKey } }),
    ).resolves.toBe(1);
    await expect(
      prisma.adminAuditLog.count({
        where: { action: "billing.ledger.adjust", targetId },
      }),
    ).resolves.toBe(1);

    const conflict = await adjust({
      userId: adminId,
      role: "admin",
      idempotencyKey,
      body: { userId: targetId, delta: 43, reason: "conflicting replay", confirmation: `${targetId}:43` },
    });
    expectError(conflict, 409, "conflict");
    expect(await dreamcoinBalance(targetId)).toBe(42);
  });

  it("404s an adjustment against a user that does not exist", async () => {
    expectError(
      await adjust({
        userId: adminId,
        role: "admin",
        body: { userId: `${P}missing`, delta: 5, reason: "unknown target", confirmation: `${P}missing:5` },
      }),
      404,
    );
  });
});
