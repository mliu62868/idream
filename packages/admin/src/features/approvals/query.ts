export type ApprovalQuery = {
  search: string;
  status: string;
  cursor: string;
};

export const defaultApprovalQuery: ApprovalQuery = {
  search: "",
  status: "pending",
  cursor: "",
};

export function approvalQueryFromSearch(search: string): ApprovalQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("approvalSearch") ?? "",
    status: params.get("approvalStatus") || "pending",
    cursor: params.get("approvalCursor") ?? "",
  };
}

export function approvalListPath(query: ApprovalQuery) {
  const params = new URLSearchParams({ limit: "25" });
  set(params, "search", query.search);
  set(params, "status", query.status);
  set(params, "cursor", query.cursor);
  return `/api/v2/admin/approvals?${params.toString()}`;
}

export function approvalWorkspaceUrl(
  pathname: string,
  search: string,
  query: ApprovalQuery,
) {
  const params = new URLSearchParams(search);
  set(params, "approvalSearch", query.search);
  set(params, "approvalStatus", query.status === "pending" ? "" : query.status);
  set(params, "approvalCursor", query.cursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
