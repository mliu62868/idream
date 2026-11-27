import { describe, expect, it } from "vitest";
import type { GenerationPricingAuthority } from "@/server/lib/generation-pricing";
import { creativeRunCostQuote } from "./run-pricing";

function authority(baseCost: number, multiplier = 1): GenerationPricingAuthority {
  return {
    id: "rule-image",
    ruleKey: "image",
    version: 1,
    baseCost,
    multiplier,
    effectiveFrom: null,
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
  };
}

describe("creativeRunCostQuote", () => {
  it("multiplies the rule base by the rule and profile multipliers for one image", () => {
    expect(creativeRunCostQuote({
      authority: authority(10, 1.5),
      profileCostMultiplier: 2,
      itemCount: 1,
    })).toEqual({ perItemCostDreamcoins: 30, totalCostDreamcoins: 30 });
  });

  it("rounds each single-image Run up before multiplying by the image count", () => {
    // ceil(10 × 1.37) = 14 per image; rounding the total once would give ceil(54.8) = 55.
    expect(creativeRunCostQuote({
      authority: authority(10),
      profileCostMultiplier: 1.37,
      itemCount: 4,
    })).toEqual({ perItemCostDreamcoins: 14, totalCostDreamcoins: 56 });
  });

  it("treats a missing profile multiplier as 1", () => {
    for (const profileCostMultiplier of [null, undefined]) {
      expect(creativeRunCostQuote({
        authority: authority(8),
        profileCostMultiplier,
        itemCount: 2,
      })).toEqual({ perItemCostDreamcoins: 8, totalCostDreamcoins: 16 });
    }
  });
});
