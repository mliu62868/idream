import { buildCompatibilityListUrl } from "@/features/compatibility-lists/query";

export type AuditQuery = {
  search: string;
  action: string;
  actorId: string;
  targetType: string;
  cursor: string;
  commandId: string;
  limit: number;
};

export const auditLimitOptions = [10, 25, 50, 100];

export const defaultAuditQuery: AuditQuery = {
  search: "",
  action: "",
  actorId: "",
  targetType: "",
  cursor: "",
  commandId: "",
  limit: 25,
};

export function auditQueryFromSearch(search: string): AuditQuery {
  const params = new URLSearchParams(search);
  const limit = Number(params.get("auditLimit"));
  return {
    search: params.get("auditSearch")?.trim() ?? "",
    action: params.get("auditAction")?.trim() ?? "",
    actorId: params.get("auditActor")?.trim() ?? "",
    targetType: params.get("auditTargetType")?.trim() ?? "",
    cursor: params.get("auditCursor")?.trim() ?? "",
    commandId: params.get("commandId")?.trim() ?? "",
    limit: auditLimitOptions.includes(limit) ? limit : 25,
  };
}

export function auditListPath(query: AuditQuery) {
  const params = new URLSearchParams();
  setQueryValue(params, "search", query.search);
  setQueryValue(params, "action", query.action);
  setQueryValue(params, "actorId", query.actorId);
  setQueryValue(params, "targetType", query.targetType);
  setQueryValue(params, "cursor", query.cursor);
  params.set("limit", String(query.limit));
  return `/api/v2/admin/audit-log?${params.toString()}`;
}

export function auditCommandPath(commandId: string) {
  return `/api/v2/admin/commands/${encodeURIComponent(commandId)}`;
}

export function auditWorkspaceUrl(
  pathname: string,
  currentSearch: string,
  updates: Readonly<Record<string, string | null>>,
  clearKeys: readonly string[] = [],
) {
  return buildCompatibilityListUrl(pathname, currentSearch, updates, clearKeys);
}

export type AuditFilterKey = "search" | "action" | "actorId" | "targetType";

const filterKeys: AuditFilterKey[] = ["search", "action", "actorId", "targetType"];

// SPEC: 相对空查询「填了哪几项」—— 折叠筛选面板后，芯片就是这张表。
// `reset` 是清掉这枚芯片要打的补丁：键是联合类型，TS 推不出来，只在这一处收敛。
export function changedAuditFilters(query: AuditQuery) {
  return filterKeys
    .filter((key) => query[key] !== defaultAuditQuery[key])
    .map((key) => ({
      key,
      value: query[key],
      reset: { [key]: defaultAuditQuery[key] } as Partial<AuditQuery>,
    }));
}

export function isAuditQueryFiltered(query: AuditQuery) {
  return changedAuditFilters(query).length > 0;
}

function setQueryValue(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized) params.set(key, normalized);
}
