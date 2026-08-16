import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listCodesRoute, POST as createCodeRoute } from "@/app/api/v2/admin/promo/redeem-codes/route";
import { POST as disableCodeRoute } from "@/app/api/v2/admin/promo/redeem-codes/[id]/disable/route";
import { GET as listReferralsRoute } from "@/app/api/v2/admin/promo/referrals/route";
import { prisma } from "@/server/lib/db";
import { redeemCodeHash } from "@/server/lib/redeem-codes";
import {
  api,
  createUser,
  expectError,
  expectOk,
  purgeTestData,
} from "@/server/test/helpers";
import { adminV2Route } from "@/server/test/admin-v2-route-client";

const P = "zt-adminv2-promo-";
const adminId = `${P}admin`;
const analystId = `${P}analyst`;
const opsId = `${P}ops`;

function listCodes(options: { userId: string; role: string; query?: Record<string, string> }) {
  return adminV2Route(listCodesRoute, {
    path: "promo/redeem-codes",
    userId: options.userId,
    role: options.role,
    query: options.query,
  });
}

function createCode(options: {
  userId: string;
  role: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  return adminV2Route(createCodeRoute, {
    method: "POST",
    path: "promo/redeem-codes",
    userId: options.userId,
    role: options.role,
    idempotencyKey: options.idempotencyKey,
    body: options.body,
  });
}

function disableCode(options: {
  id: string;
  userId: string;
  role: string;
  body: Record<string, unknown>;
}) {
  return adminV2Route(disableCodeRoute, {
    method: "POST",
    path: `promo/redeem-codes/${options.id}/disable`,
    params: { id: options.id },
    userId: options.userId,
    role: options.role,
    body: options.body,
  });
}

async function cleanup() {
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId: { startsWith: P } } });
  const codeHashes = [
    `${P}IDEMPOTENT`,
    `${P}WELCOME50`,
    `${P}WRONGCONFIRM`,
    `${P}INFINITE`,
  ].map(redeemCodeHash);
  const codes = await prisma.redeemCode.findMany({
    where: { codeHash: { in: codeHashes } },
    select: { id: true },
  });
  const codeIds = codes.map((code) => code.id);
  if (codeIds.length > 0) {
    await prisma.redeemCodeRedemption.deleteMany({ where: { redeemCodeId: { in: codeIds } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: codeIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: codeIds } } });
    await prisma.redeemCode.deleteMany({ where: { id: { in: codeIds } } });
  }
  await purgeTestData(P);
}

beforeAll(async () => {
  await cleanup();
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createUser({ id: analystId, role: "analyst", dataClass: "internal" });
  await createUser({ id: opsId, role: "ops", dataClass: "internal" });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe.sequential("Admin v2 promo: redeem codes + referrals", () => {
  it("replays an exact create command without duplicating domain, audit, or outbox rows", async () => {
    const code = `${P}IDEMPOTENT`;
    const idempotencyKey = `${P}promo-create-key`;
    const body = {
      code,
      reward: { dreamcoins: 15 },
      maxRedemptions: 5,
      reason: "verify exact command replay",
      confirmation: code,
    };
    const first = await createCode({ userId: adminId, role: "admin", idempotencyKey, body });
    const replay = await createCode({ userId: adminId, role: "admin", idempotencyKey, body });
    expectOk(first);
    expectOk(replay);
    expect(first.data.replayed).toBe(false);
    expect(replay.data).toMatchObject({ id: first.data.id, replayed: true });
    await expect(prisma.adminAuditLog.count({
      where: { action: "promo.redeem_code.create", targetId: first.data.id },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { eventType: "admin.promo.redeem_code_created.v2", aggregateId: first.data.id },
    })).resolves.toBe(1);
  });

  it("rejects a non-finite dreamcoin reward before any row is written", async () => {
    const code = `${P}INFINITE`;
    const response = await createCodeWithRawBody(code);
    expectError(response, 400, "bad_request");
    await expect(prisma.redeemCode.count({
      where: { codeHash: redeemCodeHash(code) },
    })).resolves.toBe(0);
  });

  it("creates/lists/disables redeem codes (no plaintext) with permission gating", async () => {
    expectError(await listCodes({ userId: opsId, role: "ops" }), 403);

    const created = await createCode({
      userId: adminId,
      role: "admin",
      body: {
        code: `${P}WELCOME50`,
        reward: { dreamcoins: 50, note: "welcome" },
        maxRedemptions: 100,
        reason: "launch promo",
        confirmation: `${P}WELCOME50`,
      },
    });
    expectOk(created);
    const codeId = created.data.id as string;

    const wrongConfirmation = await createCode({
      userId: adminId,
      role: "admin",
      body: {
        code: `${P}WRONGCONFIRM`,
        reward: { dreamcoins: 25 },
        maxRedemptions: 10,
        reason: "wrong confirmation",
        confirmation: "CREATE",
      },
    });
    expectError(wrongConfirmation, 400, "bad_request");

    // analyst can read, cannot write.
    expectOk(await listCodes({ userId: analystId, role: "analyst" }));
    expectError(
      await disableCode({
        id: codeId,
        userId: analystId,
        role: "analyst",
        body: { reason: "denied write", confirmation: codeId },
      }),
      403,
    );

    // Plaintext code never returned by list.
    const list = await listCodes({ userId: adminId, role: "admin" });
    expect(JSON.stringify(list.json)).not.toContain("WELCOME50");

    const redeemer = `${P}redeemer`;
    await createUser({ id: redeemer });
    const redeemed = await api("POST", "redeem-codes/redeem", {
      userId: redeemer,
      body: { code: `${P}WELCOME50` },
    });
    expectOk(redeemed);
    expect(redeemed.data.dreamcoins).toBe(50);

    const listAfterRedeem = await listCodes({ userId: adminId, role: "admin" });
    expectOk(listAfterRedeem);
    const listedCreatedCode = (listAfterRedeem.data.items as Array<{ id: string; redemptions: number }>)
      .find((item) => item.id === codeId);
    expect(listedCreatedCode?.redemptions).toBe(1);

    const wrongDisableConfirmation = await disableCode({
      id: codeId,
      userId: adminId,
      role: "admin",
      body: { reason: "fraud", confirmation: "DISABLE" },
    });
    expectError(wrongDisableConfirmation, 400, "bad_request");

    const disabled = await disableCode({
      id: codeId,
      userId: adminId,
      role: "admin",
      body: { reason: "fraud", confirmation: codeId },
    });
    expectOk(disabled);
    expect(disabled.data.status).toBe("disabled");

    // Audit must not leak the plaintext code.
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "promo.redeem_code.create", targetId: codeId },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain("WELCOME50");
  });

  it("paginates redeem codes and referrals with a query-bound cursor", async () => {
    const codeIds = [0, 1].map((index) => `${P}page-code-${index}`);
    const referralIds = [0, 1].map((index) => `${P}page-referral-${index}`);
    await prisma.redeemCode.createMany({
      data: codeIds.map((id, index) => ({
        id,
        codeHash: `${P}page-hash-${index}`,
        reward: { dreamcoins: 5 },
        status: "active",
        createdAt: new Date(Date.UTC(2026, 6, 11, 8, index)),
      })),
    });
    await prisma.referral.createMany({
      data: referralIds.map((id, index) => ({
        id,
        inviterId: adminId,
        code: `${P}page-ref-${index}`,
        status: "pending",
        createdAt: new Date(Date.UTC(2026, 6, 11, 9, index)),
      })),
    });
    try {
      for (const [route, path, query] of [
        [listCodesRoute, "promo/redeem-codes", { search: `${P}page-code`, status: "active", limit: "1" }],
        [listReferralsRoute, "promo/referrals", { search: `${P}page-referral`, status: "pending", limit: "1" }],
      ] as const) {
        const first = await adminV2Route(route, { path, userId: adminId, role: "admin", query });
        expectOk(first);
        expect(first.data.items).toHaveLength(1);
        expect(first.data.pageInfo).toMatchObject({
          hasNextPage: true,
          endCursor: expect.any(String),
        });

        const second = await adminV2Route(route, {
          path,
          userId: adminId,
          role: "admin",
          query: { ...query, cursor: first.data.pageInfo.endCursor as string },
        });
        expectOk(second);
        expect(second.data.items).toHaveLength(1);
        expect(second.data.items[0].id).not.toBe(first.data.items[0].id);

        const mismatch = await adminV2Route(route, {
          path,
          userId: adminId,
          role: "admin",
          query: { ...query, search: "different", cursor: first.data.pageInfo.endCursor as string },
        });
        expectError(mismatch, 400, "bad_request");
      }
    } finally {
      await prisma.referral.deleteMany({ where: { id: { in: referralIds } } });
      await prisma.redeemCode.deleteMany({ where: { id: { in: codeIds } } });
    }
  });

  it("lists referrals behind growth.promo.read", async () => {
    expectOk(await adminV2Route(listReferralsRoute, {
      path: "promo/referrals",
      userId: adminId,
      role: "admin",
    }));
    expectError(await adminV2Route(listReferralsRoute, {
      path: "promo/referrals",
      userId: opsId,
      role: "ops",
    }), 403);
  });
});

/**
 * `1e999` parses to `Infinity`, which no JSON literal can express through an object
 * argument — the body has to reach the handler as raw text.
 */
async function createCodeWithRawBody(code: string) {
  const response = await createCodeRoute(
    new Request("http://localhost/api/v2/admin/promo/redeem-codes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-idream-role": "admin",
        "x-idream-user-id": adminId,
      },
      body: `{"code":"${code}","reward":{"dreamcoins":1e999},"reason":"reject infinite reward","confirmation":"${code}"}`,
    }),
  );
  const json = await response.json() as { ok: boolean; data?: unknown; error?: { code?: string } };
  return {
    status: response.status,
    ok: json.ok,
    data: json.data,
    error: json.error,
    json,
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
  };
}
