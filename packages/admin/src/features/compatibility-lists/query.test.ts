import { describe, expect, it } from "vitest";
import { buildCompatibilityListUrl, readCompatibilityListQuery } from "./query";

describe("compatibility list URL authority", () => {
  it("keeps applied filters while advancing with an opaque cursor", () => {
    expect(buildCompatibilityListUrl(
      "/admin/customer-ops/billing",
      "?billingSearch=user%40example.test&subscriptionStatus=active",
      { subscriptionCursor: "opaque cursor" },
    )).toBe("/admin/customer-ops/billing?billingSearch=user%40example.test&subscriptionStatus=active&subscriptionCursor=opaque+cursor");
  });

  it("clears query-bound cursors when a visible filter changes", () => {
    expect(buildCompatibilityListUrl(
      "/admin/moderation",
      "?moderationSearch=old&reportCursor=report-old&mediaCursor=media-old&appealCursor=appeal-old",
      { moderationSearch: "new" },
      ["reportCursor", "mediaCursor", "appealCursor"],
    )).toBe("/admin/moderation?moderationSearch=new");
  });

  it("restores only the typed keys represented by a browser history URL", () => {
    expect(readCompatibilityListQuery(
      new URLSearchParams("pricingSearch=portrait&pricingMode=image&pricingCursor=opaque&unrelated=ignored"),
      ["pricingSearch", "pricingMode", "pricingStatus", "pricingCursor"],
    )).toEqual({
      pricingSearch: "portrait",
      pricingMode: "image",
      pricingStatus: "",
      pricingCursor: "opaque",
    });
  });
});
