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

/**
 * SPEC: 角色与授权包两条写命令的确认串 —— 服务端按字面比对
 *       （`access/users.ts:updateUserRole` 的 `${userId}:${role}`、
 *        `permissions/grant-bundles.ts` 的 `${userId}:${bundleKey}:grant|revoke`），
 *       差一个字符就是 400。
 * INTENT: 和 accessStatusConfirmation / accessPermissionConfirmation 同住一处，因为它们是
 *         同一件事：确认串的形状由后端定，不是界面文案。
 * INVARIANT: 不对 userId 做 trim —— 服务端拿的是路径参数，这里多 trim 一次反而会在
 *            带空格的输入上静默对不上。调用点负责传已经规整过的 ID。
 */
export function accessRoleConfirmation(userId: string, role: string) {
  return `${userId}:${role}`;
}

export function accessBundleConfirmation(
  userId: string,
  bundleKey: string,
  action: "grant" | "revoke",
) {
  return `${userId}:${bundleKey}:${action}`;
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
