import { describe, expect, it } from "vitest";
import {
  billingAdjustmentConfirmation,
  billingLedgerPath,
  billingQueryFromSearch,
  billingSubscriptionsPath,
  billingWorkspaceUrl,
  defaultBillingQuery,
  isBillingQueryFiltered,
} from "./query";

describe("billing workspace query", () => {
  it("round-trips the canonical server-side filters and independent cursors", () => {
    const query = billingQueryFromSearch(
      "?billingSearch=ada&ledgerReason=refund&subscriptionStatus=active&ledgerCursor=l-1&subscriptionCursor=s-1",
    );

    expect(query).toEqual({
      search: "ada",
      ledgerReason: "refund",
      subscriptionStatus: "active",
      ledgerCursor: "l-1",
      subscriptionCursor: "s-1",
    });
    expect(billingLedgerPath(query)).toBe(
      "/api/v1/admin/billing/ledger?search=ada&reason=refund&cursor=l-1&limit=25",
    );
    expect(billingSubscriptionsPath(query)).toBe(
      "/api/v1/admin/billing/subscriptions?search=ada&status=active&cursor=s-1&limit=25",
    );
  });

  it("clears both cursors when a filter changes and preserves unrelated URL state", () => {
    expect(billingWorkspaceUrl("/admin/billing", "?caseCursor=case-1&ledgerCursor=old", {
      billingSearch: "new query",
      ledgerCursor: null,
      subscriptionCursor: null,
    })).toBe("/admin/billing?caseCursor=case-1&billingSearch=new+query");
  });

  it("distinguishes a filtered query from the authority default", () => {
    expect(isBillingQueryFiltered(defaultBillingQuery)).toBe(false);
    expect(isBillingQueryFiltered({ ...defaultBillingQuery, ledgerReason: "refund" })).toBe(true);
  });

  it("binds high-risk confirmation to both the target and signed delta", () => {
    expect(billingAdjustmentConfirmation(" user-1 ", 37)).toBe("user-1:37");
    expect(billingAdjustmentConfirmation("user-1", -5)).toBe("user-1:-5");
  });
});
