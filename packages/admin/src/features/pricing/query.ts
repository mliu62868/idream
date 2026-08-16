import { buildCompatibilityListUrl } from "@/features/compatibility-lists/query";

export type PricingQuery = { search: string; mode: string; status: string; cursor: string };
export type PricingDraft = {
  ruleKey: string;
  label: string;
  mode: "image" | "video" | "voice";
  baseCost: string;
  multiplier: string;
  reason: string;
  confirmation: string;
};

export const defaultPricingQuery: PricingQuery = { search: "", mode: "", status: "", cursor: "" };
export const defaultPricingDraft: PricingDraft = {
  ruleKey: "generation_image_default",
  label: "Image generation default",
  mode: "image",
  baseCost: "5",
  multiplier: "1",
  reason: "",
  confirmation: "",
};

export function pricingQueryFromSearch(search: string): PricingQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("pricingSearch")?.trim() ?? "",
    mode: params.get("pricingMode")?.trim() ?? "",
    status: params.get("pricingStatus")?.trim() ?? "",
    cursor: params.get("pricingCursor")?.trim() ?? "",
  };
}

export function pricingListPath(query: PricingQuery) {
  const params = new URLSearchParams();
  set(params, "search", query.search);
  set(params, "mode", query.mode);
  set(params, "status", query.status);
  set(params, "cursor", query.cursor);
  params.set("limit", "25");
  return `/api/v2/admin/pricing/rules?${params.toString()}`;
}

export function pricingWorkspaceUrl(pathname: string, search: string, updates: Readonly<Record<string, string | null>>) {
  return buildCompatibilityListUrl(pathname, search, updates);
}

export function isPricingQueryFiltered(query: PricingQuery) {
  return Boolean(query.search || query.mode || query.status);
}

export function canCreatePricingRule(draft: PricingDraft) {
  const ruleKey = draft.ruleKey.trim();
  return Boolean(ruleKey && draft.label.trim() && draft.baseCost.trim() !== "" && draft.reason.trim().length >= 3 && draft.confirmation.trim() === ruleKey);
}

export function pricingDraftPayload(draft: PricingDraft): Record<string, unknown> {
  return {
    ruleKey: draft.ruleKey.trim(),
    label: draft.label.trim(),
    mode: draft.mode,
    baseCost: number(draft.baseCost, 5, true),
    multiplier: number(draft.multiplier, 1, false),
    reason: draft.reason.trim(),
    confirmation: draft.confirmation.trim(),
  };
}

function set(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized && normalized !== "all") params.set(key, normalized);
}

function number(value: string, fallback: number, integer: boolean) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return integer ? Math.trunc(parsed) : parsed;
}
