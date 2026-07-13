import type { TodayAllWorkQuery } from "@idream/shared/admin";

export type TodayTab = "summary" | "all";
export type TodayUrlState = Omit<Partial<TodayAllWorkQuery>, "limit"> & { tab: TodayTab; limit: number };

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
