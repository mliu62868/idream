import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as analyticsOverviewRoute } from "@/app/api/v2/admin/analytics/overview/route";
import { GET as dashboardRoute } from "@/app/api/v2/admin/dashboard/route";
import { GET as providerOpsRoute } from "@/app/api/v2/admin/ops/providers/route";
import { GET as abuseOverviewRoute } from "@/app/api/v2/admin/risk/abuse/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2, expectAdminV2Ok } from "@/server/test/admin-v2-client";
import { createUser, purgeTestData } from "@/server/test/helpers";

const P = "zt-v2ovw-";
const admin = { userId: `${P}admin`, role: "admin" };
const analyst = { userId: `${P}analyst`, role: "analyst" };
const support = { userId: `${P}support`, role: "support" };
const ops = { userId: `${P}ops`, role: "ops" };
const plainUser = { userId: `${P}user`, role: "user" };

const provider = `${P}runner`;

describe("Admin v2 operational overviews", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await createUser({ id: admin.userId, role: "admin", dataClass: "internal" });
    await createUser({ id: analyst.userId, role: "analyst", dataClass: "internal" });
    await createUser({ id: support.userId, role: "support", dataClass: "internal" });
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

  it("flags multi-account device clusters, referral farming, and adjust anomalies", async () => {
    const anon = `${P}device-shared`;
    const accountA = `${P}abuse-a`;
    const accountB = `${P}abuse-b`;
    await createUser({ id: accountA, dataClass: "customer" });
    await createUser({ id: accountB, dataClass: "customer" });
    for (const [suffix, userId] of [["a", accountA], ["b", accountB]] as const) {
      await prisma.analyticsEvent.create({
        data: {
          id: `${P}ev-${suffix}`,
          userId,
          anonymousId: anon,
          name: "signup",
          props: {},
          dataClass: "customer",
        },
      });
    }
    const fixtureAccount = `${P}abuse-fixture`;
    await createUser({ id: fixtureAccount, dataClass: "fixture" });
    await prisma.analyticsEvent.create({
      data: {
        id: `${P}ev-fixture`,
        userId: fixtureAccount,
        anonymousId: anon,
        name: "signup",
        props: {},
        dataClass: "fixture",
      },
    });

    const inviter = `${P}abuse-inviter`;
    await createUser({ id: inviter, dataClass: "customer" });
    for (let index = 0; index < 3; index += 1) {
      await prisma.referral.create({
        data: { id: `${P}ref-${index}`, inviterId: inviter, code: `${P}code-${index}` },
      });
    }

    const adjusted = `${P}abuse-adjusted`;
    await createUser({ id: adjusted, dataClass: "customer" });
    await prisma.dreamcoinLedger.create({
      data: { id: `${P}adj-1`, userId: adjusted, delta: 500, balanceAfter: 500, reason: "admin_adjust", sourceId: `${P}adj-1` },
    });
    await prisma.dreamcoinLedger.create({
      data: { id: `${P}adj-2`, userId: adjusted, delta: 500, balanceAfter: 1000, reason: "admin_adjust", sourceId: `${P}adj-2` },
    });

    const denied = await callAdminV2(abuseOverviewRoute, {
      url: "/api/v2/admin/risk/abuse",
      actor: ops,
    });
    expect(denied.status).toBe(403);

    const result = expectAdminV2Ok(await callAdminV2(abuseOverviewRoute, {
      url: "/api/v2/admin/risk/abuse",
      actor: support,
    }));
    expect(result.data.dataScope).toMatchObject({
      kind: "customer",
      includedDataClasses: ["customer"],
    });

    const cluster = (result.data.deviceClusters as Array<{
      anonymousId: string;
      accountCount: number;
      userIds: string[];
    }>).find((item) => item.anonymousId === anon);
    expect(cluster?.accountCount).toBe(2);
    expect(cluster?.userIds).toEqual(expect.arrayContaining([accountA, accountB]));

    const referral = (result.data.referralAbuse as Array<{
      inviterId: string;
      referralCount: number;
    }>).find((item) => item.inviterId === inviter);
    expect(referral?.referralCount).toBeGreaterThanOrEqual(3);

    const anomaly = (result.data.adjustAnomalies as Array<{
      userId: string;
      count: number;
      totalDelta: number;
    }>).find((item) => item.userId === adjusted);
    expect(anomaly?.count).toBe(2);
    expect(anomaly?.totalDelta).toBe(1000);
  });

  it("aggregates per-provider success rate, cost, and latency; gates by ops.queue.read", async () => {
    const owner = `${P}prov-owner`;
    await createUser({ id: owner, dataClass: "customer" });
    const t0 = new Date();
    await prisma.generationJob.create({
      data: {
        id: `${P}prov-c1`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 5,
        provider,
        createdAt: t0,
        completedAt: new Date(t0.getTime() + 2000),
      },
    });
    const fixtureOwner = `${P}prov-fixture-owner`;
    await createUser({ id: fixtureOwner, dataClass: "fixture" });
    await prisma.generationJob.create({
      data: {
        id: `${P}prov-fixture`,
        userId: fixtureOwner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 50_000,
        provider,
        createdAt: t0,
        completedAt: new Date(t0.getTime() + 60_000),
      },
    });
    await prisma.generationJob.create({
      data: {
        id: `${P}prov-c2`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        costDreamcoins: 5,
        provider,
        createdAt: t0,
        completedAt: new Date(t0.getTime() + 4000),
      },
    });
    await prisma.generationJob.create({
      data: {
        id: `${P}prov-f1`,
        userId: owner,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        costDreamcoins: 5,
        provider,
      },
    });

    const denied = await callAdminV2(providerOpsRoute, {
      url: "/api/v2/admin/ops/providers",
      actor: analyst,
    });
    expect(denied.status).toBe(403);

    const result = expectAdminV2Ok(await callAdminV2(providerOpsRoute, {
      url: "/api/v2/admin/ops/providers",
      actor: ops,
    }));
    expect(result.data.dataScope).toMatchObject({
      kind: "operational",
      excludedDataClasses: ["fixture", "audit"],
    });
    const row = (result.data.providers as Array<Record<string, number | string>>).find(
      (item) => item.provider === provider,
    );
    expect(row).toBeTruthy();
    expect(row?.total).toBe(3);
    expect(row?.completed).toBe(2);
    expect(row?.failed).toBe(1);
    expect(row?.successRate).toBe(67); // round(2/3*100)
    expect(row?.coinsCost).toBe(15);
    expect(row?.avgCostPerJob).toBe(5);
    expect(row?.latencySamples).toBe(2);
    expect(Number(row?.latencyP95Ms)).toBeGreaterThanOrEqual(2000);
  });
});
