export type ModerationQuery = {
  search: string;
  status: string;
  targetType: string;
  reportCursor: string;
  mediaCursor: string;
  appealCursor: string;
};

export type ModerationScope = "reports" | "media" | "appeals";

export const defaultModerationQuery: ModerationQuery = { search: "", status: "", targetType: "", reportCursor: "", mediaCursor: "", appealCursor: "" };

export function moderationQueryFromSearch(search: string): ModerationQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("moderationSearch") ?? "",
    status: params.get("moderationStatus") ?? "",
    targetType: params.get("moderationTargetType") ?? "",
    reportCursor: params.get("reportCursor") ?? "",
    mediaCursor: params.get("mediaCursor") ?? "",
    appealCursor: params.get("appealCursor") ?? "",
  };
}

export function moderationQueuePath(query: ModerationQuery, scope: ModerationScope) {
  const params = new URLSearchParams({ scope, limit: "25" });
  set(params, "search", query.search);
  set(params, "status", query.status);
  set(params, "targetType", query.targetType);
  set(params, "reportCursor", query.reportCursor);
  set(params, "mediaCursor", query.mediaCursor);
  set(params, "appealCursor", query.appealCursor);
  return `/api/v1/admin/moderation/queue?${params.toString()}`;
}

export function moderationWorkspaceUrl(pathname: string, search: string, query: ModerationQuery) {
  const params = new URLSearchParams(search);
  set(params, "moderationSearch", query.search);
  set(params, "moderationStatus", query.status);
  set(params, "moderationTargetType", query.targetType);
  set(params, "reportCursor", query.reportCursor);
  set(params, "mediaCursor", query.mediaCursor);
  set(params, "appealCursor", query.appealCursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

export function moderationDecisionConfirmation(kind: "action" | "close" | "uphold" | "overturn" | "modify", id: string) {
  if (kind === "action") return "TAKEDOWN";
  if (kind === "uphold") return "UPHOLD";
  if (kind === "overturn") return "OVERTURN";
  if (kind === "modify") return "MODIFY";
  return id;
}

function set(params: URLSearchParams, key: string, value: string) { if (value) params.set(key, value); else params.delete(key); }
