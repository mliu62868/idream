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
  return `/api/v1/admin/billing/ledger?${params.toString()}`;
}

export function billingSubscriptionsPath(query: BillingQuery) {
  const params = new URLSearchParams();
  set(params, "search", query.search);
  set(params, "status", query.subscriptionStatus);
  set(params, "cursor", query.subscriptionCursor);
  params.set("limit", "25");
  return `/api/v1/admin/billing/subscriptions?${params.toString()}`;
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

function set(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized && normalized !== "all") params.set(key, normalized);
}
