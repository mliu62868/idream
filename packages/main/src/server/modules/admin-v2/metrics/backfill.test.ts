import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { backfillCanonicalMetricFacts } from "./backfill";

describe("canonical metric fact backfill", () => {
  const prefix = `metric-backfill-${randomUUID()}`;
  const userId = `${prefix}-user`;
  const planId = `${prefix}-plan`;
  const subscriptionId = `${prefix}-subscription`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        role: "user",
        status: "active",
        createdAt: new Date("2026-05-01T10:00:00Z"),
      },
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
    await prisma.subscription.create({
      data: {
        id: subscriptionId,
        userId,
        planId,
        provider: "mock",
        status: "active",
        createdAt: new Date("2026-05-03T10:00:00Z"),
      },
    });
  });

  afterAll(async () => {
    await prisma.metricBackfillRun.deleteMany({ where: { source: { startsWith: prefix } } });
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { contains: prefix } } });
    await prisma.subscriptionLifecycleFact.deleteMany({ where: { userId } });
    await prisma.customerSignupFact.deleteMany({ where: { userId } });
    await prisma.subscription.deleteMany({ where: { id: subscriptionId } });
    await prisma.plan.deleteMany({ where: { id: planId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("supports dry-run, bounded keyset batches, and idempotent resume reports", async () => {
    const dryRun = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority`,
      dryRun: true,
      batchSize: 50,
      userIdPrefix: prefix,
    });
    expect(dryRun).toMatchObject({
      status: "completed",
      dryRun: true,
      scannedCount: 2,
      wouldApplyCount: 2,
      appliedCount: 0,
      mismatchCount: 0,
      validFrom: "2026-05-01T10:00:00.000Z",
    });
    expect(await prisma.customerSignupFact.count({ where: { userId } })).toBe(0);

    const applied = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority`,
      dryRun: false,
      batchSize: 1,
      userIdPrefix: prefix,
    });
    expect(applied).toMatchObject({ status: "paused", scannedCount: 1, appliedCount: 1 });
    expect(applied.nextCursor).toEqual(expect.any(String));

    const resumed = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority`,
      dryRun: false,
      batchSize: 50,
      cursor: applied.nextCursor,
      userIdPrefix: prefix,
    });
    expect(resumed).toMatchObject({ status: "completed", scannedCount: 1, appliedCount: 1 });
    expect(await prisma.customerSignupFact.count({ where: { userId } })).toBe(1);
    expect(await prisma.subscriptionLifecycleFact.count({ where: { userId } })).toBe(1);

    const rerun = await backfillCanonicalMetricFacts(prisma, {
      source: `${prefix}:main_authority:rerun`,
      dryRun: false,
      batchSize: 50,
      userIdPrefix: prefix,
    });
    expect(rerun).toMatchObject({ status: "completed", appliedCount: 0, duplicateCount: 2, mismatchCount: 0 });
    expect(rerun.before).toEqual(rerun.after);
  });
});
