import type { TodayAllWorkQuery, TodaySourceStatus, TodaySourceType } from "@idream/shared/admin";

export type TodayTab = "summary" | "all";
export type TodayUrlState = Omit<Partial<TodayAllWorkQuery>, "limit"> & { tab: TodayTab; limit: number };

export const TODAY_FILTER_KEYS = ["domain", "severity", "sla", "owner", "ownerId", "status", "environment"] as const;
export type TodayFilterKey = typeof TODAY_FILTER_KEYS[number];

/**
 * SPEC: 每个领域各自的活跃状态。
 * INTENT: 状态原先是一个扁平 select 塞 16 个值，混了六个领域 —— `creative_run` 永远不可能
 *         是 `mitigating`，选了就是一次注定为空的查询。All Work 只返回还活着的工作，
 *         所以这里也只列各域的活跃态（服务端 ACTIVE_*_STATUSES 的同一份口径）。
 */
export const TODAY_STATUS_BY_DOMAIN: Record<TodaySourceType, readonly TodaySourceStatus[]> = {
  admin_case: ["new", "triaged", "in_progress", "waiting", "reopened"],
  ops_incident: ["detected", "triaged", "mitigating", "monitoring"],
  control_plane_command: ["accepted", "running", "verifying", "failed"],
  character_release: ["draft", "validating", "in_review", "approved"],
  creative_run: ["active"],
  collaboration_mention: ["active"],
};

export const TODAY_DOMAINS = Object.keys(TODAY_STATUS_BY_DOMAIN) as TodaySourceType[];

/** 选了领域就只给该领域的状态；没选就按领域分组，别让运营在扁平列表里猜归属。 */
export function todayStatusGroups(domain?: TodaySourceType) {
  const domains = domain ? [domain] : TODAY_DOMAINS;
  return domains.map((key) => ({ domain: key, statuses: TODAY_STATUS_BY_DOMAIN[key] }));
}

export function activeTodayFilters(state: TodayUrlState) {
  return TODAY_FILTER_KEYS.flatMap((key) => {
    const value = state[key];
    return value ? [{ key, value: String(value) }] : [];
  });
}

/** 清空筛选，但留住当前标签页 —— 清筛选不是离开 All Work。 */
export function withoutTodayFilters(state: TodayUrlState): TodayUrlState {
  return { tab: state.tab, limit: state.limit };
}

export function parseTodayUrl(params: URLSearchParams): TodayUrlState {
  return {
    tab: params.get("todayTab") === "all" ? "all" : "summary",
    domain: optional(params.get("domain")) as TodayUrlState["domain"],
    severity: optional(params.get("severity")) as TodayUrlState["severity"],
    sla: optional(params.get("sla")) as TodayUrlState["sla"],
    owner: optional(params.get("owner")) as TodayUrlState["owner"],
    ownerId: optional(params.get("ownerId")),
    status: optional(params.get("status")) as TodayUrlState["status"],
    environment: optional(params.get("environment")) as TodayUrlState["environment"],
    cursor: optional(params.get("cursor")),
    limit: 25,
  };
}

export function todayAllWorkPath(state: TodayUrlState, workMode: string) {
  const params = new URLSearchParams({ workMode, limit: String(state.limit) });
  for (const key of ["domain", "severity", "sla", "owner", "ownerId", "status", "environment", "cursor"] as const) {
    const value = state[key];
    if (value) params.set(key, String(value));
  }
  return `/api/v2/admin/today/all-work?${params.toString()}`;
}

export function todayBrowserPath(state: TodayUrlState) {
  const params = new URLSearchParams();
  if (state.tab === "all") params.set("todayTab", "all");
  for (const key of ["domain", "severity", "sla", "owner", "ownerId", "status", "environment", "cursor"] as const) {
    const value = state[key];
    if (value) params.set(key, String(value));
  }
  return `/admin/today${params.size ? `?${params.toString()}` : ""}`;
}

function optional(value: string | null) {
  return value?.trim() || undefined;
}
