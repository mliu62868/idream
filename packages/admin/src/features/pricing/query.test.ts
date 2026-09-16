import { describe, expect, it } from "vitest";
import {
  canCreatePricingRule,
  canSavePricingEdit,
  defaultPricingDraft,
  pricingEditFromRow,
  pricingDraftPayload,
  pricingListPath,
  pricingQueryFromSearch,
  pricingWorkspaceUrl,
} from "./query";

describe("Pricing workspace contracts", () => {
  it("round-trips every server filter and stable cursor through canonical URL state", () => {
    const query = pricingQueryFromSearch("?pricingSearch=image&pricingMode=image&pricingStatus=draft&pricingCursor=page-2&view=pricing");
    expect(query).toEqual({ search: "image", mode: "image", status: "draft", cursor: "page-2" });
    expect(pricingListPath(query)).toBe("/api/v2/admin/pricing/rules?search=image&mode=image&status=draft&cursor=page-2&limit=25");
    expect(pricingWorkspaceUrl("/admin/growth/offers", "?view=pricing&pricingCursor=old", { pricingSearch: "image", pricingCursor: null })).toBe("/admin/growth/offers?view=pricing&pricingSearch=image");
  });

  it("keeps the versioned draft write contract and typed confirmation exact", () => {
    const draft = { ...defaultPricingDraft, ruleKey: " image_default ", label: " Image default ", baseCost: "7", multiplier: "1.25", reason: "Launch price", confirmation: "image_default" };
    expect(canCreatePricingRule(draft)).toBe(true);
    expect(pricingDraftPayload(draft)).toEqual({ ruleKey: "image_default", label: "Image default", mode: "image", baseCost: 7, multiplier: 1.25, reason: "Launch price", confirmation: "image_default" });
    expect(canCreatePricingRule({ ...draft, confirmation: "other" })).toBe(false);
  });

  // SPEC: 草稿改价的判据抄 adminPricingRulePatchRequestSchema，不是另立一套。
  // INTENT: 之前没有编辑入口，敲错一个基础价只能再建一条草稿；补上入口的同时把边界钉住，
  //         免得前端放行一个权威一定会 400 的值，运营看到的是一次没有解释的失败。
  it("only lets a draft edit through when it satisfies the authority's own bounds", () => {
    const edit = pricingEditFromRow({ id: "r1", ruleKey: "image_default", mode: "image", label: "Image default", baseCost: 7, multiplier: 1.25 });
    expect(edit).toEqual({ id: "r1", ruleKey: "image_default", mode: "image", label: "Image default", baseCost: "7", multiplier: "1.25" });
    expect(canSavePricingEdit(edit)).toBe(true);
    expect(canSavePricingEdit({ ...edit, label: "  " })).toBe(false);
    // baseCost 是 z.number().int()：小数会被权威拒掉。
    expect(canSavePricingEdit({ ...edit, baseCost: "7.5" })).toBe(false);
    expect(canSavePricingEdit({ ...edit, baseCost: "-1" })).toBe(false);
    // multiplier 的闭区间是 [0.1, 20]。
    expect(canSavePricingEdit({ ...edit, multiplier: "0.05" })).toBe(false);
    expect(canSavePricingEdit({ ...edit, multiplier: "20.5" })).toBe(false);
    expect(canSavePricingEdit({ ...edit, multiplier: "" })).toBe(false);
  });
});
