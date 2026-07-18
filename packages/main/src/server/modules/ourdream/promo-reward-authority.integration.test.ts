import { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { redeemCodeHash } from "@/server/lib/redeem-codes";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import {
  api,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";

const P = "zt-promo-reward-authority-";
const adminId = `${P}admin`;
const minimumRewardCode = `${P}MINIMUM`;
const adminCodeHashes = new Set<string>([redeemCodeHash(minimumRewardCode)]);

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: adminId, role: "admin" });
});

afterAll(async () => {
  const adminCodes = await prisma.redeemCode.findMany({
    where: { codeHash: { in: [...adminCodeHashes] } },
    select: { id: true },
  });
  const adminCodeIds = adminCodes.map((code) => code.id);
  if (adminCodeIds.length > 0) {
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: adminCodeIds } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { in: adminCodeIds } },
    });
  }
  await prisma.controlPlaneCommand.deleteMany({
    where: { actorId: adminId },
  });
  await prisma.redeemCode.deleteMany({
    where: { codeHash: { in: [...adminCodeHashes] } },
  });
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("promo reward authority", () => {
  it.each([
    ["missing", {}],
    ["null", { dreamcoins: null }],
    ["string", { dreamcoins: "100" }],
    ["fractional", { dreamcoins: 1.5 }],
    ["zero", { dreamcoins: 0 }],
    ["negative", { dreamcoins: -1 }],
    ["above the maximum", { dreamcoins: 1_000_001 }],
  ])("rejects a %s dreamcoin reward at admin creation", async (label, reward) => {
    const code = `${P}CREATE-${label}`;
    adminCodeHashes.add(redeemCodeHash(code));
    const response = await api("POST", "admin/promo/redeem-codes", {
      userId: adminId,
      role: "admin",
      body: {
        code,
        reward,
        reason: `reject ${label} reward`,
        confirmation: code,
      },
    });

    expectError(response, 400, "bad_request");
    await expect(
      prisma.redeemCode.count({
        where: { codeHash: redeemCodeHash(code) },
      }),
    ).resolves.toBe(0);
  });

  it("rejects a non-finite dreamcoin reward at admin creation", async () => {
    const code = `${P}CREATE-INFINITE`;
    adminCodeHashes.add(redeemCodeHash(code));
    const response = await dispatchV1(
      new Request("http://localhost/api/v1/admin/promo/redeem-codes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "x-idream-role": "admin",
          "x-idream-user-id": adminId,
        },
        body: `{"code":"${code}","reward":{"dreamcoins":1e999},"reason":"reject infinite reward","confirmation":"${code}"}`,
      }),
      ["admin", "promo", "redeem-codes"],
    );

    expect(response.status).toBe(400);
    await expect(
      prisma.redeemCode.count({
        where: { codeHash: redeemCodeHash(code) },
      }),
    ).resolves.toBe(0);
  });

  it("keeps the minimum positive dreamcoin reward valid", async () => {
    const response = await api("POST", "admin/promo/redeem-codes", {
      userId: adminId,
      role: "admin",
      body: {
        code: minimumRewardCode,
        reward: { dreamcoins: 1 },
        reason: "verify minimum reward",
        confirmation: minimumRewardCode,
      },
    });

    expectOk(response);
    const stored = await prisma.redeemCode.findUniqueOrThrow({
      where: { codeHash: redeemCodeHash(minimumRewardCode) },
      select: { reward: true, status: true },
    });
    expect(stored).toEqual({
      reward: { dreamcoins: 1 },
      status: "active",
    });
  });

  it("serializes concurrent users against a code-wide redemption limit", async () => {
    const code = `${P}CONCURRENT-LIMIT`;
    const redeemCodeId = `${P}concurrent-limit-code`;
    const userIds = [`${P}concurrent-user-a`, `${P}concurrent-user-b`];
    await Promise.all(userIds.map((id) => createUser({ id })));
    await prisma.redeemCode.create({
      data: {
        id: redeemCodeId,
        codeHash: redeemCodeHash(code),
        reward: { dreamcoins: 25 },
        status: "active",
        maxRedemptions: 1,
      },
    });

    const results = await Promise.all(
      userIds.map((userId) =>
        api("POST", "redeem-codes/redeem", {
          userId,
          body: { code },
        }),
      ),
    );

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await prisma.redeemCodeRedemption.count({
      where: { redeemCodeId },
    })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({
      where: { userId: { in: userIds }, reason: "redeem" },
    })).toBe(1);
  });

  it("re-reads status after waiting for the row lock", async () => {
    const code = `${P}LOCK-REREAD`;
    const redeemCodeId = `${P}lock-reread-code`;
    const userId = `${P}lock-reread-user`;
    await createUser({ id: userId });
    await prisma.redeemCode.create({
      data: {
        id: redeemCodeId,
        codeHash: redeemCodeHash(code),
        reward: { dreamcoins: 50 },
        status: "active",
      },
    });

    let markLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM redeem_codes WHERE id = ${redeemCodeId} FOR UPDATE`;
      markLocked();
      await release;
      await tx.redeemCode.update({
        where: { id: redeemCodeId },
        data: { status: "disabled" },
      });
    });

    await locked;
    const redemption = api("POST", "redeem-codes/redeem", {
      userId,
      body: { code },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLock();
    await blocker;

    const response = await redemption;
    expectError(response, 404, "not_found");
    expect(await prisma.redeemCodeRedemption.count({
      where: { redeemCodeId, userId },
    })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({
      where: { userId, reason: "redeem" },
    })).toBe(0);
  });

  it("disables malformed historical rewards without rewriting payloads and is repeatable", async () => {
    const migration = await readFile(
      new URL(
        "../../../../prisma/migrations/20260716035000_redeem_code_reward_authority/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const fixtures = [
      { id: `${P}migration-zero`, reward: { dreamcoins: 0 }, valid: false },
      { id: `${P}migration-missing`, reward: { note: "preserve me" }, valid: false },
      { id: `${P}migration-fraction`, reward: { dreamcoins: 1.5 }, valid: false },
      { id: `${P}migration-min`, reward: { dreamcoins: 1 }, valid: true },
      { id: `${P}migration-max`, reward: { dreamcoins: 1_000_000 }, valid: true },
    ] as const;
    await prisma.redeemCode.createMany({
      data: fixtures.map((fixture) => ({
        id: fixture.id,
        codeHash: redeemCodeHash(fixture.id),
        reward: fixture.reward,
        status: "active",
      })),
    });

    await prisma.$executeRawUnsafe(migration);
    await prisma.$executeRawUnsafe(migration);

    const stored = await prisma.redeemCode.findMany({
      where: { id: { in: fixtures.map((fixture) => fixture.id) } },
      select: { id: true, reward: true, status: true },
    });
    const byId = new Map(stored.map((code) => [code.id, code]));
    for (const fixture of fixtures) {
      expect(byId.get(fixture.id)).toEqual({
        id: fixture.id,
        reward: fixture.reward,
        status: fixture.valid ? "active" : "disabled",
      });
    }
  });

  it.each([
    ["array", []],
    ["JSON null", Prisma.JsonNull],
    ["string reward", "100"],
    ["missing", {}],
    ["null", { dreamcoins: null }],
    ["string", { dreamcoins: "100" }],
    ["fractional", { dreamcoins: 1.5 }],
    ["zero", { dreamcoins: 0 }],
    ["negative", { dreamcoins: -1 }],
    ["above the maximum", { dreamcoins: 1_000_001 }],
  ] satisfies Array<
    [string, Prisma.JsonNullValueInput | Prisma.InputJsonValue]
  >)(
    "fails closed when redeeming a %s stored reward without writing usage or ledger",
    async (label, reward) => {
      const suffix = label.replaceAll(" ", "-");
      const userId = `${P}redeemer-${suffix}`;
      const code = `${P}REDEEM-${suffix}`;
      const redeemCodeId = `${P}code-${suffix}`;
      await createUser({ id: userId });
      await prisma.redeemCode.create({
        data: {
          id: redeemCodeId,
          codeHash: redeemCodeHash(code),
          reward,
          status: "active",
        },
      });

      const response = await api("POST", "redeem-codes/redeem", {
        userId,
        body: { code },
      });

      expectError(response, 500, "internal");
      await expect(
        prisma.redeemCodeRedemption.count({
          where: { redeemCodeId, userId },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.dreamcoinLedger.count({
          where: { userId, reason: "redeem" },
        }),
      ).resolves.toBe(0);
      await expect(dreamcoinBalance(userId)).resolves.toBe(0);
    },
  );
});
