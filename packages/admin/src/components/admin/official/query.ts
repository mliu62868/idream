import { GENDERS, STYLES } from "./official-api";
import { setWorkspaceUrl, type WorkspaceHistoryMode } from "@/lib/admin-v2-api";
import { observeWorkspacePopState } from "@/lib/workspace-history";

export type OfficialListQuery = {
  search: string;
  gender: "all" | (typeof GENDERS)[number];
  style: "all" | (typeof STYLES)[number];
  status: "all" | "draft" | "approved" | "archived";
  page: number;
};

export const defaultOfficialListQuery: OfficialListQuery = {
  search: "",
  gender: "all",
  style: "all",
  status: "all",
  page: 1,
};

const statuses = ["draft", "approved", "archived"] as const;

export function parseOfficialListQuery(params: URLSearchParams): OfficialListQuery {
  const gender = params.get("gender");
  const style = params.get("style");
  const status = params.get("status");
  const page = Number(params.get("page"));
  return {
    search: params.get("search")?.trim() ?? "",
    gender: gender && GENDERS.includes(gender as (typeof GENDERS)[number])
      ? gender as OfficialListQuery["gender"]
      : "all",
    style: style && STYLES.includes(style as (typeof STYLES)[number])
      ? style as OfficialListQuery["style"]
      : "all",
    status: status && statuses.includes(status as (typeof statuses)[number])
      ? status as OfficialListQuery["status"]
      : "all",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function buildOfficialListUrlQuery(query: OfficialListQuery): URLSearchParams {
  const params = new URLSearchParams();
  append(params, "search", query.search);
  if (query.gender !== "all") params.set("gender", query.gender);
  if (query.style !== "all") params.set("style", query.style);
  if (query.status !== "all") params.set("status", query.status);
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

export function buildOfficialListApiQuery(query: OfficialListQuery): URLSearchParams {
  const params = new URLSearchParams({ page: String(query.page), limit: "24" });
  append(params, "search", query.search);
  if (query.gender !== "all") params.set("gender", query.gender);
  if (query.style !== "all") params.set("style", query.style);
  if (query.status !== "all") params.set("status", query.status);
  return params;
}

export function writeOfficialListUrl(query: OfficialListQuery, mode: WorkspaceHistoryMode) {
  setWorkspaceUrl(buildOfficialListUrlQuery(query), { mode });
}

export function observeOfficialListUrl(
  target: Pick<Window, "addEventListener" | "removeEventListener"> & {
    location: Pick<Location, "search">;
  },
  restore: (query: OfficialListQuery) => void,
) {
  return observeWorkspacePopState(
    target,
    () => parseOfficialListQuery(new URLSearchParams(target.location.search)),
    restore,
  );
}

function append(params: URLSearchParams, key: string, value: string) {
  const normalized = value.trim();
  if (normalized) params.set(key, normalized);
}
