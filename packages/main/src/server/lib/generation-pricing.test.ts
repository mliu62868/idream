import { readFileSync } from "node:fs";
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
  it("fails closed when no active rule exists", async () => {
    await expect(
      generationCostDreamcoins(`${P}missing` as "image", 1, 1),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Generation pricing is unavailable",
    });
  });

  it("uses the mode's single active rule and ignores archived history", async () => {
    const mode = `${P}newest-rule`;
    await prisma.pricingRule.create({
      data: {
        id: `${P}rule-v1`,
        ruleKey: `${P}rule-newest`,
        label: "Older archived rule",
        mode,
        baseCost: 3,
        multiplier: 1,
        status: "archived",
        version: 1,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        publishedAt: new Date(),
      },
    });
    await prisma.pricingRule.create({
      data: {
        id: `${P}rule-v2`,
        ruleKey: `${P}rule-newest`,
        label: "Current active rule",
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

  it("fails closed when corrupted data contains multiple active rules", async () => {
    const mode = `${P}ambiguous`;
    await prisma.pricingRule.createMany({
      data: [
        {
          id: `${P}ambiguous-v1`,
          ruleKey: `${P}ambiguous`,
          label: "Ambiguous v1",
          mode,
          baseCost: 42,
          multiplier: 1,
          status: "active",
          version: 1,
        },
        {
          id: `${P}ambiguous-v2`,
          ruleKey: `${P}ambiguous`,
          label: "Ambiguous v2",
          mode,
          baseCost: 100,
          multiplier: 1,
          status: "active",
          version: 2,
        },
      ],
    });

    await expect(
      generationCostDreamcoins(mode as "video", 2, 1),
    ).rejects.toMatchObject({
      code: "conflict",
      details: {
        mode,
        reason: "ambiguous_active_rules",
      },
    });
  });

  it("does not charge a future-dated rule before it becomes effective", async () => {
    const mode = `${P}future`;
    await prisma.pricingRule.create({
      data: {
        id: `${P}future-v1`,
        ruleKey: `${P}future`,
        label: "Future price",
        mode,
        baseCost: 99,
        multiplier: 1,
        status: "active",
        version: 1,
        effectiveFrom: new Date(Date.now() + 86_400_000),
        publishedAt: new Date(),
      },
    });

    await expect(
      generationCostDreamcoins(mode as "image", 1, 1),
    ).rejects.toMatchObject({
      code: "conflict",
      details: {
        mode,
        reason: "missing_active_rule",
      },
    });
  });

  it("keeps seed reruns from reactivating defaults over an existing authority", () => {
    const seedSource = readFileSync(
      new URL("../../../prisma/seed.ts", import.meta.url),
      "utf8",
    );

    expect(seedSource).toContain("if (activeAuthorities.length === 1) return;");
    expect(seedSource).toContain("if (existingHistory)");
    expect(seedSource).toContain("publish one explicitly");
    expect(seedSource).toContain("ensureDefaultPricingRule");
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
