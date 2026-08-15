import { describe, expect, it } from "vitest";
import {
  billingAdjustmentConfirmation,
  billingLedgerPath,
  billingRefundAcknowledgementConfirmation,
  billingSubscriptionRefundConfirmation,
  billingSubscriptionRefundReconcileConfirmation,
  billingQueryFromSearch,
  billingSubscriptionsPath,
  billingWorkspaceUrl,
  defaultBillingQuery,
  isBillingQueryFiltered,
  isRefundAcknowledgementCandidate,
  isSubscriptionRefundable,
  parseLedgerAdjustmentDelta,
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

  it("accepts only non-zero safe integer ledger deltas", () => {
    expect(parseLedgerAdjustmentDelta("37")).toBe(37);
    expect(parseLedgerAdjustmentDelta(" -5 ")).toBe(-5);
    expect(parseLedgerAdjustmentDelta("0")).toBeNull();
    expect(parseLedgerAdjustmentDelta("1.5")).toBeNull();
    expect(parseLedgerAdjustmentDelta("1e3")).toBeNull();
    expect(parseLedgerAdjustmentDelta("9007199254740992")).toBeNull();
  });

  it("exposes refund acknowledgement only for unresolved settled abandonment", () => {
    const candidate = {
      id: "checkout-1",
      failureCode: "provider_invoice_settled_after_abandonment",
      needsReconciliation: true,
      providerInvoiceStatus: "settled",
      providerSessionId: "invoice-1",
      status: "provider_unknown",
    };
    expect(isRefundAcknowledgementCandidate(candidate)).toBe(true);
    expect(
      isRefundAcknowledgementCandidate({
        ...candidate,
        needsReconciliation: false,
      }),
    ).toBe(false);
    expect(
      billingRefundAcknowledgementConfirmation(" checkout-1 "),
    ).toBe("checkout-1:refund_acknowledged");
  });

  it("binds subscription refund actions to an active settled authority", () => {
    const candidate = {
      id: "subscription-1",
      checkoutId: "checkout-1",
      status: "active",
      canRefund: true,
    };
    expect(isSubscriptionRefundable(candidate)).toBe(true);
    expect(
      isSubscriptionRefundable({ ...candidate, status: "refund_pending" }),
    ).toBe(false);
    expect(
      isSubscriptionRefundable({ ...candidate, canRefund: false }),
    ).toBe(false);
    expect(billingSubscriptionRefundConfirmation(" subscription-1 ")).toBe(
      "subscription-1:refund",
    );
    expect(
      billingSubscriptionRefundReconcileConfirmation(" subscription-1 "),
    ).toBe("subscription-1:refund_reconcile");
  });
});
