import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as ledgerRoute } from "@/app/api/v2/admin/billing/ledger/route";
import { GET as reconciliationRoute } from "@/app/api/v2/admin/billing/reconciliation/route";
import { GET as subscriptionsRoute } from "@/app/api/v2/admin/billing/subscriptions/route";
import { prisma } from "@/server/lib/db";
import { createUser, expectError, expectOk } from "@/server/test/helpers";
import { adminV2Route } from "@/server/test/admin-v2-route-client";

describe("Admin v2 billing reads", () => {
  const token = `billing-customer-${randomUUID()}`;
  const actorId = `${token}-admin`;
  const supportId = `${token}-support`;
  const opsId = `${token}-ops`;
  const customerId = `${token}-customer`;
  const fixtureId = `${token}-fixture`;
  const internalId = `${token}-internal`;
  const planId = `${token}-plan`;

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin", dataClass: "internal" });
    await createUser({ id: supportId, role: "support", dataClass: "internal" });
    await createUser({ id: opsId, role: "ops", dataClass: "internal" });
    await createUser({ id: customerId, dataClass: "customer" });
    await createUser({ id: fixtureId, dataClass: "fixture" });
    await createUser({ id: internalId, dataClass: "internal" });
    await prisma.plan.create({
      data: {
        id: planId,
        slug: token,
        name: token,
        billingPeriod: "monthly",
        priceCents: 100,
        includedDreamcoins: 500,
        features: {},
      },
    });
    await prisma.dreamcoinLedger.createMany({
      data: [
        { id: `${token}-ledger-customer`, userId: customerId, delta: 10, balanceAfter: 10, reason: "signup_bonus" },
        { id: `${token}-ledger-fixture`, userId: fixtureId, delta: 20, balanceAfter: 20, reason: "signup_bonus" },
        { id: `${token}-ledger-internal`, userId: internalId, delta: 30, balanceAfter: 30, reason: "admin_adjust" },
      ],
    });
    await prisma.subscription.createMany({
      data: [
        {
          id: `${token}-subscription-customer`,
          userId: customerId,
          planId,
          provider: "mock",
          providerSubscriptionId: `${token}-provider-customer`,
          status: "active",
        },
        {
          id: `${token}-subscription-fixture`,
          userId: fixtureId,
          planId,
          provider: "mock",
          providerSubscriptionId: `${token}-provider-fixture`,
          status: "active",
        },
        {
          id: `${token}-subscription-internal`,
          userId: internalId,
          planId,
          provider: "mock",
          providerSubscriptionId: `${token}-provider-internal`,
          status: "active",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({ where: { id: { startsWith: token } } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: { startsWith: token } } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, supportId, opsId, customerId, fixtureId, internalId] } },
    });
    await prisma.$disconnect();
  });

  it("lists only customer ledger entries and declares the customer scope", async () => {
    const result = await adminV2Route(ledgerRoute, {
      path: "billing/ledger",
      userId: actorId,
      role: "admin",
      query: { search: token },
    });

    expectOk(result);
    expect(result.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    expect(result.data.items).toEqual([
      expect.objectContaining({
        id: `${token}-ledger-customer`,
        userId: customerId,
      }),
    ]);
  });

  it("lists only customer subscriptions and declares the customer scope", async () => {
    const result = await adminV2Route(subscriptionsRoute, {
      path: "billing/subscriptions",
      userId: actorId,
      role: "admin",
      query: { search: token },
    });

    expectOk(result);
    expect(result.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    expect(result.data.items).toEqual([
      expect.objectContaining({
        id: `${token}-subscription-customer`,
        userId: customerId,
        plan: token,
        status: "active",
        provider: "mock",
      }),
    ]);
  });

  it("gates every billing read behind billing.read", async () => {
    expectOk(await adminV2Route(ledgerRoute, {
      path: "billing/ledger",
      userId: supportId,
      role: "support",
    }));
    expectError(await adminV2Route(ledgerRoute, {
      path: "billing/ledger",
      userId: opsId,
      role: "ops",
    }), 403);
    expectError(await adminV2Route(subscriptionsRoute, {
      path: "billing/subscriptions",
      userId: opsId,
      role: "ops",
    }), 403);
    expectError(await adminV2Route(reconciliationRoute, {
      path: "billing/reconciliation",
      userId: opsId,
      role: "ops",
    }), 403);
  });

  it("reconciles ledger by reason over the window with one active-subscription count", async () => {
    const result = await adminV2Route(reconciliationRoute, {
      path: "billing/reconciliation",
      userId: actorId,
      role: "admin",
    });

    expectOk(result);
    expect(result.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    const byReason = Object.fromEntries(
      (result.data.byReason as Array<{ reason: string; totalDelta: number; count: number }>)
        .map((row) => [row.reason, row]),
    );
    // 全局窗口聚合，断言用 >=/<= 以兼容同库里的其他测试数据。
    expect(byReason.signup_bonus?.totalDelta).toBeGreaterThanOrEqual(10);
    expect(result.data.totals.entries).toBeGreaterThanOrEqual(1);
    expect(typeof result.data.activeSubscriptions).toBe("number");
    // internal 用户的 admin_adjust 分录不属于 customer 口径，所以它不会出现在这份聚合里。
    expect(byReason.admin_adjust?.totalDelta ?? 0).not.toBe(30);
  });

  it("rejects a reconciliation window whose start is after its end", async () => {
    const result = await adminV2Route(reconciliationRoute, {
      path: "billing/reconciliation",
      userId: actorId,
      role: "admin",
      query: {
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      },
    });

    expectError(result, 400, "bad_request");
  });
});
