export type AccessQuery = { search: string; role: string; status: string; cursor: string };

export const defaultAccessQuery: AccessQuery = { search: "", role: "", status: "", cursor: "" };

export function accessQueryFromSearch(search: string): AccessQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("accessSearch") ?? "",
    role: params.get("accessRole") ?? "",
    status: params.get("accessStatus") ?? "",
    cursor: params.get("accessCursor") ?? "",
  };
}

export function accessListPath(query: AccessQuery) {
  return withQuery("/api/v1/admin/users", {
    q: query.search,
    role: query.role,
    status: query.status,
    cursor: query.cursor,
    limit: "25",
  });
}

export function accessWorkspaceUrl(pathname: string, search: string, query: AccessQuery) {
  const params = new URLSearchParams(search);
  set(params, "accessSearch", query.search);
  set(params, "accessRole", query.role);
  set(params, "accessStatus", query.status);
  set(params, "accessCursor", query.cursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

export function accessPermissionConfirmation(userId: string, permissionKey: string, effect: string) {
  return `${userId.trim()}:${permissionKey}:${effect}`;
}

export function accessStatusConfirmation(userId: string, status: string) {
  return `${userId}:${status}`;
}

function withQuery(path: string, values: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) set(params, key, value);
  return `${path}?${params.toString()}`;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
