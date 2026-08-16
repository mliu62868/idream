import { describe, expect, it } from "vitest";
import {
  promoListPath,
  promoQueryFromSearch,
  promoWorkspaceUrl,
} from "./query";

describe("promo query", () => {
  it("uses independent cursors for code and referral authorities", () => {
    const query = promoQueryFromSearch(
      "?promoSearch=summer&promoStatus=active&referralStatus=pending&promoCursor=code-next&referralCursor=ref-next",
    );
    expect(promoListPath(query, "codes")).toBe(
      "/api/v2/admin/promo/redeem-codes?limit=25&search=summer&status=active&cursor=code-next",
    );
    expect(promoListPath(query, "referrals")).toBe(
      "/api/v2/admin/promo/referrals?limit=25&search=summer&status=pending&cursor=ref-next",
    );
  });

  it("round-trips URL state", () => {
    const query = promoQueryFromSearch("");
    expect(promoWorkspaceUrl("/admin/promo", "?view=growth", query)).toBe(
      "/admin/promo?view=growth",
    );
  });
});
