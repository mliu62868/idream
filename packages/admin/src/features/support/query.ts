export type SupportQuery = {
  search: string;
  status: string;
  sla: string;
  category: string;
  cursor: string;
};

export const defaultSupportQuery: SupportQuery = {
  search: "",
  status: "all",
  sla: "all",
  category: "",
  cursor: "",
};

export function supportQueryFromSearch(search: string): SupportQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("search") ?? "",
    status: params.get("status") || "all",
    sla: params.get("sla") || "all",
    category: params.get("category") ?? "",
    cursor: params.get("cursor") ?? "",
  };
}

export function supportListPath(query: SupportQuery) {
  const params = new URLSearchParams({ limit: "25" });
  set(params, "search", query.search);
  set(params, "status", query.status === "all" ? "" : query.status);
  set(params, "sla", query.sla === "all" ? "" : query.sla);
  set(params, "category", query.category);
  set(params, "cursor", query.cursor);
  return `/api/v1/admin/support/requests?${params.toString()}`;
}

export function supportWorkspaceUrl(
  pathname: string,
  search: string,
  query: SupportQuery,
) {
  const params = new URLSearchParams(search);
  set(params, "search", query.search);
  set(params, "status", query.status === "all" ? "" : query.status);
  set(params, "sla", query.sla === "all" ? "" : query.sla);
  set(params, "category", query.category);
  set(params, "cursor", query.cursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
