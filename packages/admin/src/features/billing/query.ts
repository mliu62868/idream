import { buildCompatibilityListUrl } from "@/features/compatibility-lists/query";

export type BillingQuery = {
  search: string;
  ledgerReason: string;
  subscriptionStatus: string;
  ledgerCursor: string;
  subscriptionCursor: string;
};

export const defaultBillingQuery: BillingQuery = {
  search: "",
  ledgerReason: "",
  subscriptionStatus: "",
  ledgerCursor: "",
  subscriptionCursor: "",
};

export function billingQueryFromSearch(search: string): BillingQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("billingSearch")?.trim() ?? "",
    ledgerReason: params.get("ledgerReason")?.trim() ?? "",
    subscriptionStatus: params.get("subscriptionStatus")?.trim() ?? "",
    ledgerCursor: params.get("ledgerCursor")?.trim() ?? "",
    subscriptionCursor: params.get("subscriptionCursor")?.trim() ?? "",
  };
}

export function billingLedgerPath(query: BillingQuery) {
  const params = new URLSearchParams();
  set(params, "search", query.search);
  set(params, "reason", query.ledgerReason);
  set(params, "cursor", query.ledgerCursor);
  params.set("limit", "25");
  return `/api/v2/admin/billing/ledger?${params.toString()}`;
}

export function billingSubscriptionsPath(query: BillingQuery) {
  const params = new URLSearchParams();
  set(params, "search", query.search);
  set(params, "status", query.subscriptionStatus);
  set(params, "cursor", query.subscriptionCursor);
  params.set("limit", "25");
  return `/api/v2/admin/billing/subscriptions?${params.toString()}`;
}

export function billingWorkspaceUrl(
  pathname: string,
  search: string,
  updates: Readonly<Record<string, string | null>>,
) {
  return buildCompatibilityListUrl(pathname, search, updates);
}

export function isBillingQueryFiltered(query: BillingQuery) {
  return Boolean(query.search || query.ledgerReason || query.subscriptionStatus);
}

export function billingAdjustmentConfirmation(userId: string, delta: number) {
  return `${userId.trim()}:${delta}`;
}

export function billingRefundAcknowledgementConfirmation(checkoutId: string) {
  return `${checkoutId.trim()}:refund_acknowledged`;
}

export function billingSubscriptionRefundConfirmation(subscriptionId: string) {
  return `${subscriptionId.trim()}:refund`;
}

export function billingSubscriptionRefundReconcileConfirmation(
  subscriptionId: string,
) {
  return `${subscriptionId.trim()}:refund_reconcile`;
}

export function isSubscriptionRefundable(
  subscription: Pick<
    AdminBillingSubscriptionListItem,
    "status" | "canRefund" | "checkoutId"
  >,
) {
  return (
    subscription.status === "active" &&
    subscription.canRefund === true &&
    typeof subscription.checkoutId === "string" &&
    subscription.checkoutId.length > 0
  );
}

export function isRefundAcknowledgementCandidate(
  checkout: Readonly<Record<string, unknown>>,
) {
  return (
    checkout.status === "provider_unknown" &&
    checkout.failureCode ===
      "provider_invoice_settled_after_abandonment" &&
    checkout.needsReconciliation === true &&
    checkout.providerInvoiceStatus === "settled" &&
    typeof checkout.providerSessionId === "string" &&
    checkout.providerSessionId.length > 0
  );
}

export function parseLedgerAdjustmentDelta(value: string) {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function set(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized && normalized !== "all") params.set(key, normalized);
}
import type { AdminBillingSubscriptionListItem } from "@idream/shared/admin";
