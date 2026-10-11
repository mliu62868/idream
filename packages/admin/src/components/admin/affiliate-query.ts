export type AffiliateQuery = {
  status: "pending" | "approved" | "rejected" | "all";
  search: string;
  cursor: string;
  applicationId: string | null;
};

export const defaultAffiliateQuery: AffiliateQuery = { status: "pending", search: "", cursor: "", applicationId: null };

export function parseAffiliateQuery(params: URLSearchParams): AffiliateQuery {
  const status = params.get("affiliateStatus");
  return {
    status: status === "all" || status === "approved" || status === "rejected" ? status : "pending",
    search: params.get("affiliateSearch")?.trim() ?? "",
    cursor: params.get("affiliateCursor") ?? "",
    applicationId: params.get("affiliateApplication") || null,
  };
}

export function affiliateQueryParams(current: URLSearchParams, query: AffiliateQuery) {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries({ affiliateStatus: query.status === "pending" ? "" : query.status, affiliateSearch: query.search, affiliateCursor: query.cursor, affiliateApplication: query.applicationId })) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  if (current.get("affiliateApplication") !== query.applicationId) {
    for (const key of ["attributionFrom", "attributionTo", "attributionCursor"]) params.delete(key);
  }
  return params;
}
