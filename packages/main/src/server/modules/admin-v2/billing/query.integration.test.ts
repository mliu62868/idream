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
        {
          id: `${token}-ledger-customer`,
          userId: customerId,
          delta: 10,
          balanceAfter: 10,
          reason: "signup_bonus",
          createdAt: new Date(Date.UTC(2026, 6, 11, 1, 0)),
        },
        {
          id: `${token}-ledger-customer-2`,
          userId: customerId,
          delta: 5,
          balanceAfter: 15,
          reason: "signup_bonus",
          createdAt: new Date(Date.UTC(2026, 6, 11, 1, 1)),
        },
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
          createdAt: new Date(Date.UTC(2026, 6, 11, 2, 0)),
        },
        {
          id: `${token}-subscription-customer-2`,
          userId: customerId,
          planId,
          provider: "mock",
          providerSubscriptionId: `${token}-provider-customer-2`,
          status: "active",
          createdAt: new Date(Date.UTC(2026, 6, 11, 2, 1)),
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
    await prisma.checkoutSession.deleteMany({ where: { userId: { in: [customerId, fixtureId, internalId] } } });
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
    expect(result.data.items.map((item: { id: string }) => item.id).sort()).toEqual([
      `${token}-ledger-customer`,
      `${token}-ledger-customer-2`,
    ]);
    expect(result.data.items[0]).toMatchObject({ userId: customerId });
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
    expect(result.data.items.map((item: { id: string }) => item.id).sort()).toEqual([
      `${token}-subscription-customer`,
      `${token}-subscription-customer-2`,
    ]);
    expect(result.data.items[0]).toMatchObject({
      userId: customerId,
      plan: token,
      status: "active",
      provider: "mock",
    });
  });

  it("paginates ledger and subscriptions with a query-bound cursor", async () => {
    for (const [route, path, query] of [
      [ledgerRoute, "billing/ledger", { search: token, limit: "1" }],
      [subscriptionsRoute, "billing/subscriptions", { search: token, status: "active", limit: "1" }],
    ] as const) {
      const first = await adminV2Route(route, {
        path,
        userId: actorId,
        role: "admin",
        query,
      });
      expectOk(first);
      expect(first.data.items).toHaveLength(1);
      expect(first.data.pageInfo).toMatchObject({
        hasNextPage: true,
        endCursor: expect.any(String),
      });

      const second = await adminV2Route(route, {
        path,
        userId: actorId,
        role: "admin",
        query: { ...query, cursor: first.data.pageInfo.endCursor as string },
      });
      expectOk(second);
      expect(second.data.items).toHaveLength(1);
      expect(second.data.items[0].id).not.toBe(first.data.items[0].id);

      // 游标绑定发出它的那次查询；换了过滤条件就必须失效。
      const mismatch = await adminV2Route(route, {
        path,
        userId: actorId,
        role: "admin",
        query: { ...query, search: "different", cursor: first.data.pageInfo.endCursor as string },
      });
      expectError(mismatch, 400, "bad_request");
    }
  });

  it("rejects malformed billing list and reconciliation queries at the boundary", async () => {
    expectError(await adminV2Route(ledgerRoute, {
      path: "billing/ledger",
      userId: actorId,
      role: "admin",
      query: { limit: "1junk" },
    }), 400);
    expectError(await adminV2Route(subscriptionsRoute, {
      path: "billing/subscriptions",
      userId: actorId,
      role: "admin",
      query: { status: "mystery" },
    }), 400);
    expectError(await adminV2Route(reconciliationRoute, {
      path: "billing/reconciliation",
      userId: actorId,
      role: "admin",
      query: { from: "not-a-date" },
    }), 400);
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
    // 显式给窗口：夹具的账本分录带固定 createdAt，默认的「近 30 天」窗口盖不到它们。
    const result = await adminV2Route(reconciliationRoute, {
      path: "billing/reconciliation",
      userId: actorId,
      role: "admin",
      query: { from: "2026-07-01T00:00:00.000Z" },
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
    expect(byReason.signup_bonus?.totalDelta).toBeGreaterThanOrEqual(15);
    expect(result.data.totals.entries).toBeGreaterThanOrEqual(2);
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
