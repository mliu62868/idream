import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as analyticsOverviewRoute } from "@/app/api/v2/admin/analytics/overview/route";
import { GET as dashboardRoute } from "@/app/api/v2/admin/dashboard/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2, expectAdminV2Ok } from "@/server/test/admin-v2-client";
import { createUser, purgeTestData } from "@/server/test/helpers";

const P = "zt-v2ovw-";
const analyst = { userId: `${P}analyst`, role: "analyst" };
const ops = { userId: `${P}ops`, role: "ops" };
const plainUser = { userId: `${P}user`, role: "user" };

describe("Admin v2 operational overviews", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await createUser({ id: analyst.userId, role: "analyst", dataClass: "internal" });
    await createUser({ id: ops.userId, role: "ops", dataClass: "internal" });
    await createUser({ id: plainUser.userId, role: "user", dataClass: "internal" });
  });

  afterAll(async () => {
    await purgeTestData(P);
    await prisma.$disconnect();
  });

  it("gates the dashboard on dashboard.read", async () => {
    const allowed = expectAdminV2Ok(await callAdminV2(dashboardRoute, {
      url: "/api/v2/admin/dashboard",
      actor: analyst,
    }));
    expect(allowed.data.metrics.generation).toBeTruthy();
    expect(allowed.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    expect(Array.isArray(allowed.data.featureFlags)).toBe(true);

    const denied = await callAdminV2(dashboardRoute, {
      url: "/api/v2/admin/dashboard",
      actor: plainUser,
    });
    expect(denied.status).toBe(403);
  });

  it("aggregates funnel/economy and gates by analytics.export", async () => {
    const owner = `${P}an-owner`;
    await createUser({ id: owner, dataClass: "customer" });
    const plan = await prisma.plan.findFirstOrThrow({ where: { slug: "premium" } });
    await prisma.subscription.create({
      data: { id: `${P}an-sub`, userId: owner, planId: plan.id, provider: "mock", status: "active" },
    });
    await prisma.generationJob.create({
      data: {
        id: `${P}an-job`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 5,
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}an-grant`,
        userId: owner,
        delta: 100,
        balanceAfter: 100,
        reason: "subscription_grant",
        sourceId: `${P}an-grant`,
      },
    });
    const fixtureOwner = `${P}an-fixture-owner`;
    await createUser({ id: fixtureOwner, dataClass: "fixture" });
    await prisma.generationJob.create({
      data: {
        id: `${P}an-fixture-job`,
        userId: fixtureOwner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 50_000,
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}an-fixture-grant`,
        userId: fixtureOwner,
        delta: 50_000,
        balanceAfter: 50_000,
        reason: "subscription_grant",
        sourceId: `${P}an-fixture-grant`,
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: `${P}an-spend`,
        userId: owner,
        delta: -5,
        balanceAfter: 95,
        reason: "generation_spend",
        sourceId: `${P}an-job`,
      },
    });

    const denied = await callAdminV2(analyticsOverviewRoute, {
      url: "/api/v2/admin/analytics/overview",
      actor: ops,
    });
    expect(denied.status).toBe(403);

    const overview = expectAdminV2Ok(await callAdminV2(analyticsOverviewRoute, {
      url: "/api/v2/admin/analytics/overview",
      actor: analyst,
    }));
    expect(overview.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });
    // Phase 0 truth containment: exact signups stay visible, but generation-as-activation
    // and cross-window conversion stay invalid for decisions.
    expect(overview.data.funnel.signups).toBeGreaterThanOrEqual(1);
    expect(overview.data.funnel).toMatchObject({
      activatedUsers: null,
      payingUsers: null,
      conversionRate: null,
      qualityState: "invalid",
      validForDecisions: false,
    });
    expect(overview.data.funnel.legacyObserved).toMatchObject({
      activatedUsers: expect.any(Number),
      payingUsers: expect.any(Number),
      conversionRate: expect.any(Number),
    });
    expect(overview.data.generation.total).toBeGreaterThanOrEqual(1);
    expect(overview.data.economy.coinsGranted).toBeGreaterThanOrEqual(100);
    expect(overview.data.economy.coinsGranted).toBeLessThan(50_000);
    expect(overview.data.economy.coinsSpent).toBeLessThanOrEqual(-5);
    expect(Array.isArray(overview.data.topEvents)).toBe(true);
  });

  it("rejects a malformed analytics window", async () => {
    const result = await callAdminV2(analyticsOverviewRoute, {
      url: "/api/v2/admin/analytics/overview",
      actor: analyst,
      query: { from: "not-a-date" },
    });
    expect(result.status).toBe(400);
  });
});
