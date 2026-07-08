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

  it("matches ceil(activeBaseCost-or-fallback * count * multiplier) for a shared mode", async () => {
    // "video" is a real mode other tests/seed data may also touch, so we cannot
    // assert an exact literal here (parallel-unsafe). Instead mirror the SSoT
    // query ourselves and assert the function's result is consistent with it —
    // this covers both "active rule wins" and "no active rule falls back to
    // the built-in base cost" without assuming DB isolation.
    const activeRule = await prisma.pricingRule.findFirst({
      where: { mode: "video", status: "active" },
      orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    });
    const expectedBase = activeRule?.baseCost ?? 100;

    expect(await generationCostDreamcoins("video", 2, 1)).toBe(
      Math.ceil(expectedBase * 2 * 1),
    );
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
