import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { purgeTestData } from "@/server/test/helpers";
import { generationCostDreamcoins } from "./generation-pricing";

const P = "zt-gen-pricing-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("generationCostDreamcoins", () => {
  it("uses the newest active rule's baseCost, ordered by effectiveFrom/version desc", async () => {
    // mode is unique to this test, so no other (parallel) test's rule can win the ordering.
    const mode = `${P}newest-rule`;
    await prisma.pricingRule.create({
      data: {
        id: `${P}rule-v1`,
        ruleKey: `${P}rule-newest`,
        label: "Older active rule",
        mode,
        baseCost: 3,
        multiplier: 1,
        status: "active",
        version: 1,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        publishedAt: new Date(),
      },
    });
    await prisma.pricingRule.create({
      data: {
        id: `${P}rule-v2`,
        ruleKey: `${P}rule-newest`,
        label: "Newest active rule",
        mode,
        baseCost: 7,
        multiplier: 1,
        status: "active",
        version: 2,
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
        publishedAt: new Date(),
      },
    });

    expect(await generationCostDreamcoins(mode as "image", 2, 1)).toBe(14);
  });

  it("wins the ordering on the real 'video' mode via a far-future effectiveFrom + high version", async () => {
    // "video" is a real, shared mode — other concurrent tests (e.g.
    // admin-console.test.ts's video-pricing publish/rollback case) may create
    // and mutate their own active video rules at the same time. Rather than
    // read-then-assert against whatever happens to be active (a TOCTOU race:
    // the effective rule can change between our read and the call under
    // test), we seed a rule that is guaranteed to sort first — a far-future
    // effectiveFrom and a version no concurrent test would plausibly use —
    // so the assertion is deterministic regardless of what else is active.
    // We only ever delete our own P-prefixed row, so this can't disturb the
    // concurrent admin-console rule it created.
    const ruleId = `${P}rule-video-wins`;
    await prisma.pricingRule.create({
      data: {
        id: ruleId,
        ruleKey: `${P}rule-video-wins`,
        label: "Deterministically-newest video rule",
        mode: "video",
        baseCost: 42,
        multiplier: 1,
        status: "active",
        version: 999_999,
        effectiveFrom: new Date("2099-01-01T00:00:00.000Z"),
        publishedAt: new Date(),
      },
    });

    try {
      expect(await generationCostDreamcoins("video", 2, 1)).toBe(84);
    } finally {
      await prisma.pricingRule.delete({ where: { id: ruleId } });
    }
  });

  it("scales linearly with the multiplier (cost2x = 2 * cost1x)", async () => {
    const mode = `${P}multiplier`;
    await prisma.pricingRule.create({
      data: {
        id: `${P}rule-multiplier`,
        ruleKey: `${P}rule-multiplier`,
        label: "Multiplier rule",
        mode,
        baseCost: 10,
        multiplier: 1,
        status: "active",
        version: 1,
        effectiveFrom: new Date(),
        publishedAt: new Date(),
      },
    });

    const cost1x = await generationCostDreamcoins(mode as "image", 1, 1);
    const cost2x = await generationCostDreamcoins(mode as "image", 1, 2);

    expect(cost2x).toBe(cost1x * 2);
  });

  it("rounds fractional costs up with Math.ceil", async () => {
    const mode = `${P}ceil`;
    await prisma.pricingRule.create({
      data: {
        id: `${P}rule-ceil`,
        ruleKey: `${P}rule-ceil`,
        label: "Ceil rule",
        mode,
        baseCost: 10,
        multiplier: 1,
        status: "active",
        version: 1,
        effectiveFrom: new Date(),
        publishedAt: new Date(),
      },
    });

    // 10 * 1 * 1.25 = 12.5 → must round up to 13, never down to 12.
    expect(await generationCostDreamcoins(mode as "image", 1, 1.25)).toBe(13);
  });
});
