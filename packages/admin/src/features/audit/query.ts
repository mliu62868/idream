import { buildCompatibilityListUrl } from "@/features/compatibility-lists/query";

export type AuditQuery = {
  search: string;
  action: string;
  actorId: string;
  targetType: string;
  cursor: string;
  commandId: string;
};

export const defaultAuditQuery: AuditQuery = {
  search: "",
  action: "",
  actorId: "",
  targetType: "",
  cursor: "",
  commandId: "",
};

export function auditQueryFromSearch(search: string): AuditQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("auditSearch")?.trim() ?? "",
    action: params.get("auditAction")?.trim() ?? "",
    actorId: params.get("auditActor")?.trim() ?? "",
    targetType: params.get("auditTargetType")?.trim() ?? "",
    cursor: params.get("auditCursor")?.trim() ?? "",
    commandId: params.get("commandId")?.trim() ?? "",
  };
}

export function auditListPath(query: AuditQuery) {
  const params = new URLSearchParams();
  setQueryValue(params, "search", query.search);
  setQueryValue(params, "action", query.action);
  setQueryValue(params, "actorId", query.actorId);
  setQueryValue(params, "targetType", query.targetType);
  setQueryValue(params, "cursor", query.cursor);
  params.set("limit", "25");
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

export function isAuditQueryFiltered(query: AuditQuery) {
  return Boolean(query.search || query.action || query.actorId || query.targetType);
}

function setQueryValue(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized) params.set(key, normalized);
}
