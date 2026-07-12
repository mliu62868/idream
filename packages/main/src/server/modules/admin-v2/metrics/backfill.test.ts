import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { backfillCanonicalMetricFacts } from "./backfill";
import { loadCanonicalMetricDataset } from "./projector";

describe("canonical metric fact backfill", () => {
  const prefix = `metric-backfill-${randomUUID()}`;
  const customerId = `${prefix}-customer`;
  const fixtureId = `${prefix}-fixture`;
  const internalId = `${prefix}-internal`;
  const userIds = [customerId, fixtureId, internalId];
  const planId = `${prefix}-plan`;
  const subscriptionIds = userIds.map((userId) => `${userId}-subscription`);

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: customerId,
          email: `${customerId}@customer.invalid`,
          role: "user",
          status: "active",
          createdAt: new Date("2026-05-01T10:00:00Z"),
        },
        {
          id: fixtureId,
          email: `${fixtureId}@example.test`,
          role: "user",
          status: "active",
          createdAt: new Date("2026-05-01T11:00:00Z"),
        },
        {
          id: internalId,
          email: `${internalId}@idream.internal`,
          role: "admin",
          status: "active",
          createdAt: new Date("2026-05-01T12:00:00Z"),
        },
      ],
    });
    await prisma.plan.create({
      data: {
        id: planId,
        slug: prefix,
        name: "Backfill plan",
        billingPeriod: "monthly",
        priceCents: 1000,
        features: {},
      },
    });
    await prisma.subscription.createMany({
      data: userIds.map((userId, index) => ({
        id: subscriptionIds[index],
        userId,
        planId,
        provider: "mock",
        status: "active",
        createdAt: new Date(`2026-05-03T1${index}:00:00Z`),
      })),
    });
  });

  afterAll(async () => {
    await prisma.metricBackfillRun.deleteMany({ where: { source: { startsWith: prefix } } });
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { contains: prefix } } });
    await prisma.subscriptionLifecycleFact.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.customerSignupFact.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.subscription.deleteMany({ where: { id: { in: subscriptionIds } } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("reports only authoritative customers as eligible during a dry run", async () => {
    const dryRun = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority`,
      dryRun: true,
      batchSize: 50,
      userIdPrefix: prefix,
    });
    expect(dryRun).toMatchObject({
      status: "completed",
      dryRun: true,
      scannedCount: 6,
      wouldApplyCount: 2,
      appliedCount: 0,
      mismatchCount: 0,
      validFrom: "2026-05-01T10:00:00.000Z",
    });
    expect(await loadCanonicalMetricDataset(prisma, { userIds })).toEqual({
      signups: [],
      chatExchanges: [],
      generationDeliveries: [],
      subscriptions: [],
    });
  });

  it("applies customer facts while skipping fixture and internal actors idempotently", async () => {
    const applied = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority`,
      dryRun: false,
      batchSize: 1,
      userIdPrefix: prefix,
    });
    expect(applied).toMatchObject({
      status: "paused",
      scannedCount: 1,
      wouldApplyCount: 1,
      appliedCount: 1,
      mismatchCount: 0,
    });
    expect(applied.nextCursor).toEqual(expect.any(String));

    const resumed = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority`,
      dryRun: false,
      batchSize: 50,
      cursor: applied.nextCursor,
      userIdPrefix: prefix,
    });
    expect(resumed).toMatchObject({
      status: "completed",
      scannedCount: 5,
      wouldApplyCount: 1,
      appliedCount: 1,
      skippedCount: 4,
      mismatchCount: 0,
    });
    expect(await loadCanonicalMetricDataset(prisma, { userIds })).toMatchObject({
      signups: [{ userId: customerId, eligible: true }],
      subscriptions: [{ userId: customerId, eligible: true }],
    });

    const rerun = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority:rerun`,
      dryRun: false,
      batchSize: 50,
      userIdPrefix: prefix,
    });
    expect(rerun).toMatchObject({
      status: "completed",
      appliedCount: 0,
      duplicateCount: 2,
      skippedCount: 4,
      mismatchCount: 0,
    });
    expect(rerun.before).toEqual(rerun.after);
  });
});
