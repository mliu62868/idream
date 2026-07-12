export type ChatOpsQuery = {
  userId: string;
  characterId: string;
  sessionStatus: string;
  eventStatus: string;
  eventLayer: string;
  policyCode: string;
  targetId: string;
  limit: string;
  sessionCursor: string;
  usageCursor: string;
  eventCursor: string;
};

export type ChatOpsAuthority =
  | "overview"
  | "providers"
  | "sessions"
  | "usage"
  | "events";

export const defaultChatOpsQuery: ChatOpsQuery = {
  userId: "",
  characterId: "",
  sessionStatus: "active",
  eventStatus: "all",
  eventLayer: "all",
  policyCode: "",
  targetId: "",
  limit: "50",
  sessionCursor: "",
  usageCursor: "",
  eventCursor: "",
};

const paths: Record<ChatOpsAuthority, string> = {
  overview: "/api/v1/admin/chat/overview",
  providers: "/api/v1/admin/chat/provider-health",
  sessions: "/api/v1/admin/chat/sessions",
  usage: "/api/v1/admin/chat/usage",
  events: "/api/v1/admin/chat/moderation-events",
};

export function chatOpsQueryFromSearch(search: string): ChatOpsQuery {
  const params = new URLSearchParams(search);
  const limit = params.get("chatLimit") ?? "";
  return {
    userId: params.get("chatUserId") ?? "",
    characterId: params.get("chatCharacterId") ?? "",
    sessionStatus: params.get("chatSessionStatus") || "active",
    eventStatus: params.get("chatEventStatus") || "all",
    eventLayer: params.get("chatEventLayer") || "all",
    policyCode: params.get("chatPolicyCode") ?? "",
    targetId: params.get("chatTargetId") ?? "",
    limit: ["25", "50", "100"].includes(limit) ? limit : "50",
    sessionCursor: params.get("chatSessionCursor") ?? "",
    usageCursor: params.get("chatUsageCursor") ?? "",
    eventCursor: params.get("chatEventCursor") ?? "",
  };
}

export function chatOpsPath(query: ChatOpsQuery, authority: ChatOpsAuthority) {
  if (authority === "overview" || authority === "providers")
    return paths[authority];
  const params = new URLSearchParams({ limit: query.limit });
  if (authority === "sessions") {
    set(params, "userId", query.userId);
    set(params, "characterId", query.characterId);
    set(
      params,
      "status",
      query.sessionStatus === "all" ? "" : query.sessionStatus,
    );
    set(params, "cursor", query.sessionCursor);
  }
  if (authority === "usage") {
    set(params, "userId", query.userId);
    set(params, "cursor", query.usageCursor);
  }
  if (authority === "events") {
    set(params, "status", query.eventStatus === "all" ? "" : query.eventStatus);
    set(params, "layer", query.eventLayer === "all" ? "" : query.eventLayer);
    set(params, "policyCode", query.policyCode);
    set(params, "targetId", query.targetId);
    set(params, "cursor", query.eventCursor);
  }
  return `${paths[authority]}?${params.toString()}`;
}

export function chatOpsWorkspaceUrl(
  pathname: string,
  search: string,
  query: ChatOpsQuery,
) {
  const params = new URLSearchParams(search);
  set(params, "chatUserId", query.userId);
  set(params, "chatCharacterId", query.characterId);
  set(
    params,
    "chatSessionStatus",
    query.sessionStatus === "active" ? "" : query.sessionStatus,
  );
  set(
    params,
    "chatEventStatus",
    query.eventStatus === "all" ? "" : query.eventStatus,
  );
  set(
    params,
    "chatEventLayer",
    query.eventLayer === "all" ? "" : query.eventLayer,
  );
  set(params, "chatPolicyCode", query.policyCode);
  set(params, "chatTargetId", query.targetId);
  set(params, "chatLimit", query.limit === "50" ? "" : query.limit);
  set(params, "chatSessionCursor", query.sessionCursor);
  set(params, "chatUsageCursor", query.usageCursor);
  set(params, "chatEventCursor", query.eventCursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
