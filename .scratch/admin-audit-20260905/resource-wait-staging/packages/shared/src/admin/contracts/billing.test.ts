import { describe, expect, it } from "vitest";
import {
  adminBillingSubscriptionListResponseSchema,
  adminSubscriptionRefundCommandResponseSchema,
} from "./billing";

const refund = {
  subscriptionId: "subscription-1",
  checkoutId: "checkout-1",
  reference: "idream-refund:checkout-1:command-1",
  state: "completed",
  amountCents: 1_999,
  currency: "usd",
  reversedDreamcoins: 1_500,
  balanceAfter: 242,
  claimUrl: null,
  providerRefundId: "refund-1",
  payouts: [
    { payoutId: "payout-1", state: "completed", paymentProofId: "tx-1" },
  ],
  requestedAt: "2026-08-15T00:00:00.000Z",
  completedAt: "2026-08-15T00:01:00.000Z",
  restoredAt: null,
  restoredBalanceAfter: null,
} as const;

describe("admin billing contracts", () => {
  it("pins the subscription list refund projection", () => {
    expect(
      adminBillingSubscriptionListResponseSchema.parse({
        dataScope: {
          kind: "customer",
          includedDataClasses: ["customer"],
          excludedDataClasses: ["fixture", "internal"],
        },
        items: [
          {
            id: "subscription-1",
            userId: "user-1",
            userEmail: "user@example.com",
            plan: "premium",
            billingPeriod: "monthly",
            includedDreamcoins: 1_500,
            provider: "btcpay",
            status: "refunded",
            currentPeriodEnd: "2026-09-15T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            providerSubscriptionId: "invoice-1",
            checkoutId: "checkout-1",
            amountCents: 1_999,
            currency: "usd",
            refund,
            canRefund: false,
            createdAt: "2026-08-15T00:00:00.000Z",
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      }).items[0]?.refund,
    ).toMatchObject({ state: "completed", amountCents: 1_999 });
  });

  it("pins the refund command result used by Admin", () => {
    expect(
      adminSubscriptionRefundCommandResponseSchema.parse({
        checkoutId: "checkout-1",
        subscriptionId: "subscription-1",
        subscriptionStatus: "refunded",
        refund,
        settlement: {
          reversedDreamcoins: 1_500,
          balanceAfter: 242,
          restoredDreamcoins: 0,
          restoredBalanceAfter: null,
        },
        replayed: false,
      }).subscriptionStatus,
    ).toBe("refunded");
  });
});
