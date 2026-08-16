export type PromoQuery = {
  search: string;
  codeStatus: string;
  referralStatus: string;
  codeCursor: string;
  referralCursor: string;
};

export type PromoScope = "codes" | "referrals";

const promoPaths: Record<PromoScope, string> = {
  codes: "/api/v2/admin/promo/redeem-codes",
  referrals: "/api/v2/admin/promo/referrals",
};

export const defaultPromoQuery: PromoQuery = {
  search: "",
  codeStatus: "",
  referralStatus: "",
  codeCursor: "",
  referralCursor: "",
};

export function promoQueryFromSearch(search: string): PromoQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("promoSearch") ?? "",
    codeStatus: params.get("promoStatus") ?? "",
    referralStatus: params.get("referralStatus") ?? "",
    codeCursor: params.get("promoCursor") ?? "",
    referralCursor: params.get("referralCursor") ?? "",
  };
}

export function promoListPath(query: PromoQuery, scope: PromoScope) {
  const params = new URLSearchParams({ limit: "25" });
  set(params, "search", query.search);
  set(
    params,
    "status",
    scope === "codes" ? query.codeStatus : query.referralStatus,
  );
  set(
    params,
    "cursor",
    scope === "codes" ? query.codeCursor : query.referralCursor,
  );
  return `${promoPaths[scope]}?${params.toString()}`;
}

export function promoWorkspaceUrl(
  pathname: string,
  search: string,
  query: PromoQuery,
) {
  const params = new URLSearchParams(search);
  set(params, "promoSearch", query.search);
  set(params, "promoStatus", query.codeStatus);
  set(params, "referralStatus", query.referralStatus);
  set(params, "promoCursor", query.codeCursor);
  set(params, "referralCursor", query.referralCursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
