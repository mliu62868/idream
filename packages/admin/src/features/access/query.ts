import {
  ADMIN_DATA_CLASSES,
  type AdminDataClass,
} from "@idream/shared/admin";

export type AccessDataClassFilter = "" | AdminDataClass;
export type AccessQuery = {
  search: string;
  role: string;
  status: string;
  dataClass: AccessDataClassFilter;
  cursor: string;
};

/** 分页条要报「第 N–M 条」，算法需要每页条数，所以它不能只活在 URL 拼接里。 */
export const ACCESS_PAGE_SIZE = 25;

export const defaultAccessQuery: AccessQuery = {
  search: "",
  role: "",
  status: "",
  dataClass: "",
  cursor: "",
};

export function accessQueryFromSearch(search: string): AccessQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("accessSearch") ?? "",
    role: params.get("accessRole") ?? "",
    status: params.get("accessStatus") ?? "",
    dataClass: accessDataClass(params.get("accessDataClass")),
    cursor: params.get("accessCursor") ?? "",
  };
}

export function accessListPath(query: AccessQuery) {
  return withQuery("/api/v2/admin/users", {
    q: query.search,
    role: query.role,
    status: query.status,
    dataClass: query.dataClass,
    cursor: query.cursor,
    limit: String(ACCESS_PAGE_SIZE),
  });
}

export function accessWorkspaceUrl(pathname: string, search: string, query: AccessQuery) {
  const params = new URLSearchParams(search);
  set(params, "accessSearch", query.search);
  set(params, "accessRole", query.role);
  set(params, "accessStatus", query.status);
  set(params, "accessDataClass", query.dataClass);
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

function accessDataClass(value: string | null): AccessDataClassFilter {
  return ADMIN_DATA_CLASSES.find((dataClass) => dataClass === value) ?? "";
}
