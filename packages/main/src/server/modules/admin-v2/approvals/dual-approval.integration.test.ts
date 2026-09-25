import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";
import { DUAL_APPROVAL_FLAG } from "./enforcement";

const P = `zt-dual-approval-${randomUUID().slice(0, 8)}-`;
const requester = `${P}requester`;
const approver = `${P}approver`;
const codes: string[] = [];

async function requestAndApprove(body: Record<string, unknown>) {
  const created = await adminV2("POST", "approvals", {
    userId: requester,
    role: "admin",
    body: { ...body, reason: "needs a second look", confirmation: `${body.targetId}:${body.action}` },
  });
  expectOk(created);
  const id = created.data.request.id as string;
  expectOk(await adminV2("POST", `approvals/${id}/approve`, {
    userId: approver,
    role: "admin",
    body: { reason: "looks right", confirmation: id },
  }));
  return id;
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: requester, role: "admin", dataClass: "internal" });
  await createUser({ id: approver, role: "admin", dataClass: "internal" });
  await prisma.featureFlag.upsert({
    where: { key: DUAL_APPROVAL_FLAG },
    update: { enabled: true, rolloutPercent: 100 },
    create: { key: DUAL_APPROVAL_FLAG, label: "Dual approval", enabled: true, rolloutPercent: 100, targetRoles: [], targetPlans: [] },
  });
});

afterAll(async () => {
  await prisma.featureFlag.deleteMany({ where: { key: DUAL_APPROVAL_FLAG } });
  await prisma.redeemCode.deleteMany({ where: { id: { in: codes } } });
  await prisma.pricingRule.deleteMany({ where: { mode: { startsWith: P } } });
  await prisma.adminActionRequest.deleteMany({ where: { requestedById: requester } });
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("dual approval", () => {
  // INVARIANT: 裁决是 CAS；两个审批人并发时恰好一个成功，另一个 409，结果不会被覆盖。
  it("lets exactly one concurrent decision win", async () => {
    const created = await adminV2("POST", "approvals", {
      userId: requester,
      role: "admin",
      body: {
        permissionKey: "billing.ledger.adjust",
        action: "billing.ledger.adjust",
        targetType: "user",
        targetId: `${P}user`,
        payload: { delta: 5000 },
        reason: "race the decision",
        confirmation: `${P}user:billing.ledger.adjust`,
      },
    });
    expectOk(created);
    const id = created.data.request.id as string;
    const [approve, reject] = await Promise.all([
      adminV2("POST", `approvals/${id}/approve`, { userId: approver, role: "admin", body: { reason: "approve it", confirmation: id } }),
      adminV2("POST", `approvals/${id}/reject`, { userId: approver, role: "admin", body: { reason: "reject it", confirmation: id } }),
    ]);
    const statuses = [approve.status, reject.status].sort();
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);
    const winner = approve.status === 200 ? "approved" : "rejected";
    await expect(prisma.adminActionRequest.findUnique({ where: { id } })).resolves.toMatchObject({ status: winner });
  });

  it("binds a pricing publish approval to the price; editing the draft voids it", async () => {
    const mode = `${P}mode`;
    const rule = await prisma.pricingRule.create({
      data: { ruleKey: `${P}rule`, label: "Dual approval price", mode, baseCost: 4, multiplier: 1, status: "draft", version: 1 },
    });
    const publish = () => adminV2("POST", `pricing/rules/${rule.id}/publish`, {
      userId: requester,
      role: "admin",
      body: { reason: "publish bound price", confirmation: rule.id },
    });
    expectError(await publish(), 403);

    const pricingApproval = {
      permissionKey: "config.pricing.write",
      action: "config.pricing.publish",
      targetType: "pricing_rule",
      targetId: rule.id,
    };
    expectError(await adminV2("POST", "approvals", {
      userId: requester,
      role: "admin",
      body: { ...pricingApproval, payload: { baseCost: 4 }, reason: "unbound approval", confirmation: `${rule.id}:config.pricing.publish` },
    }), 400, "bad_request");
    expectError(await adminV2("POST", "approvals", {
      userId: requester,
      role: "admin",
      body: { ...pricingApproval, payload: { baseCost: "4", multiplier: 1, version: 1 }, reason: "stringly approval", confirmation: `${rule.id}:config.pricing.publish` },
    }), 400, "bad_request");

    await requestAndApprove({ ...pricingApproval, payload: { baseCost: 4, multiplier: 1, version: 1 } });
    expectOk(await adminV2("PATCH", `pricing/rules/${rule.id}`, { userId: requester, role: "admin", body: { baseCost: 400 } }));
    expectError(await publish(), 403);

    await requestAndApprove({ ...pricingApproval, payload: { baseCost: 400, multiplier: 1, version: 1 } });
    const published = await publish();
    expectOk(published);
    expect(published.data.rule).toMatchObject({ status: "active", baseCost: 400 });
  });

  it("gates large redeem codes on an approval bound to reward and uses", async () => {
    const create = (code: string, dreamcoins: number, maxRedemptions: number | null) => adminV2("POST", "promo/redeem-codes", {
      userId: requester,
      role: "admin",
      body: { code, reward: { dreamcoins }, maxRedemptions, reason: "promo test", confirmation: code },
    });
    const small = await create(`${P}SMALL`, 10, 5);
    expectOk(small);
    codes.push(small.data.id);

    expectError(await create(`${P}UNLIMITED`, 10, null), 403);
    expectError(await create(`${P}BIG`, 2000, 1), 403);

    await requestAndApprove({
      permissionKey: "growth.promo.write",
      action: "promo.redeem_code.create",
      targetType: "redeem_code",
      targetId: "redeem_code",
      payload: { dreamcoins: 2000, maxRedemptions: 1 },
    });
    expectError(await create(`${P}BIG`, 2000, 2), 403);
    const big = await create(`${P}BIG`, 2000, 1);
    expectOk(big);
    codes.push(big.data.id);
  });
  // INVARIANT: 开着的双人复核不能被一个人关掉（放在最后：它会关掉开关）。
  it("needs an approval to switch dual approval off", async () => {
    const disable = () => adminV2("PATCH", `feature-flags/${DUAL_APPROVAL_FLAG}`, {
      userId: requester,
      role: "admin",
      body: { enabled: false, reason: "turn off review", confirmation: `${DUAL_APPROVAL_FLAG}:disabled` },
    });
    expectError(await disable(), 403);
    expect(await prisma.featureFlag.findUnique({ where: { key: DUAL_APPROVAL_FLAG } })).toMatchObject({ enabled: true });
    await requestAndApprove({ permissionKey: "config.feature_flag.write", action: "config.feature_flag.write", targetType: "feature_flag", targetId: DUAL_APPROVAL_FLAG, payload: {} });
    expectOk(await disable());
    expect(await prisma.featureFlag.findUnique({ where: { key: DUAL_APPROVAL_FLAG } })).toMatchObject({ enabled: false });
  });
});
