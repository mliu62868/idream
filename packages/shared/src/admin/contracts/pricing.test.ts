import { describe, expect, it } from "vitest";
import { adminPricingRulePublishRequestSchema } from "./pricing";

describe("pricing publication confirmation", () => {
  const confirmed = {
    expectedVersion: 2,
    expectedBaseCost: 0,
    expectedMultiplier: 1.25,
    reason: "Reviewed the current price",
    confirmation: "pricing-rule-id",
  };

  it("accepts the exact confirmed version and price including zero cost", () => {
    expect(adminPricingRulePublishRequestSchema.parse(confirmed)).toEqual(confirmed);
  });

  it.each(["expectedVersion", "expectedBaseCost", "expectedMultiplier"] as const)("requires %s instead of accepting unbound publication", (field) => {
    expect(adminPricingRulePublishRequestSchema.safeParse({ ...confirmed, [field]: undefined }).success).toBe(false);
  });
});
