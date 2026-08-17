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

/** 页大小是请求参数与分页条读数共用的同一个数，只允许有一份。 */
export const APPROVAL_PAGE_SIZE = 25;

export function approvalQueryFromSearch(search: string): ApprovalQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("approvalSearch") ?? "",
    status: params.get("approvalStatus") || "pending",
    cursor: params.get("approvalCursor") ?? "",
  };
}

export function approvalListPath(query: ApprovalQuery) {
  const params = new URLSearchParams({ limit: String(APPROVAL_PAGE_SIZE) });
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
