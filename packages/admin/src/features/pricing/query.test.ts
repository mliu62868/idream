import { describe, expect, it } from "vitest";
import {
  canCreatePricingRule,
  defaultPricingDraft,
  pricingDraftPayload,
  pricingListPath,
  pricingQueryFromSearch,
  pricingWorkspaceUrl,
} from "./query";

describe("Pricing workspace contracts", () => {
  it("round-trips every server filter and stable cursor through canonical URL state", () => {
    const query = pricingQueryFromSearch("?pricingSearch=image&pricingMode=image&pricingStatus=draft&pricingCursor=page-2&view=pricing");
    expect(query).toEqual({ search: "image", mode: "image", status: "draft", cursor: "page-2" });
    expect(pricingListPath(query)).toBe("/api/v1/admin/pricing/rules?search=image&mode=image&status=draft&cursor=page-2&limit=25");
    expect(pricingWorkspaceUrl("/admin/growth/offers", "?view=pricing&pricingCursor=old", { pricingSearch: "image", pricingCursor: null })).toBe("/admin/growth/offers?view=pricing&pricingSearch=image");
  });

  it("keeps the versioned draft write contract and typed confirmation exact", () => {
    const draft = { ...defaultPricingDraft, ruleKey: " image_default ", label: " Image default ", baseCost: "7", multiplier: "1.25", reason: "Launch price", confirmation: "image_default" };
    expect(canCreatePricingRule(draft)).toBe(true);
    expect(pricingDraftPayload(draft)).toEqual({ ruleKey: "image_default", label: "Image default", mode: "image", baseCost: 7, multiplier: 1.25, reason: "Launch price", confirmation: "image_default" });
    expect(canCreatePricingRule({ ...draft, confirmation: "other" })).toBe(false);
  });
});
