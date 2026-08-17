import type { SavedViewQueryState } from "@idream/shared/admin";

export type SupportQuery = {
  search: string;
  status: string;
  sla: string;
  category: string;
  cursor: string;
};

export const defaultSupportQuery: SupportQuery = {
  search: "",
  status: "all",
  sla: "all",
  category: "",
  cursor: "",
};

/** 页大小是请求参数、分页条读数与 Saved View 存档共用的同一个数，只允许有一份。 */
export const SUPPORT_PAGE_SIZE = 25;

export function supportQueryFromSearch(search: string): SupportQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("search") ?? "",
    status: params.get("status") || "all",
    sla: params.get("sla") || "all",
    category: params.get("category") ?? "",
    cursor: params.get("cursor") ?? "",
  };
}

export function supportListPath(query: SupportQuery) {
  const params = new URLSearchParams({ limit: String(SUPPORT_PAGE_SIZE) });
  set(params, "search", query.search);
  set(params, "status", query.status === "all" ? "" : query.status);
  set(params, "sla", query.sla === "all" ? "" : query.sla);
  set(params, "category", query.category);
  set(params, "cursor", query.cursor);
  return `/api/v2/admin/support/requests?${params.toString()}`;
}

export function supportWorkspaceUrl(
  pathname: string,
  search: string,
  query: SupportQuery,
) {
  const params = new URLSearchParams(search);
  set(params, "search", query.search);
  set(params, "status", query.status === "all" ? "" : query.status);
  set(params, "sla", query.sla === "all" ? "" : query.sla);
  set(params, "category", query.category);
  set(params, "cursor", query.cursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

/**
 * SPEC: Saved View 存的是 v2 的 `queryState`，不是支持台自己的筛选对象。
 * INTENT: 服务端契约只认 `{search, filters, sort, pageSize}` 这一种形状 —— 把翻译放在这里，
 *         工作台就不用知道存储形态，反过来也一样。
 */
export function supportSavedState(query: SupportQuery): SavedViewQueryState {
  return {
    search: query.search.trim(),
    filters: {
      status: query.status,
      sla: query.sla,
      category: query.category.trim(),
    },
    sort: { field: "priority", direction: "asc" },
    pageSize: SUPPORT_PAGE_SIZE,
  };
}

export function supportQueryFromSavedState(state: SavedViewQueryState): SupportQuery {
  return {
    search: state.search,
    status: filterValue(state.filters.status, "all"),
    sla: filterValue(state.filters.sla, "all"),
    category: filterValue(state.filters.category, ""),
    cursor: "",
  };
}

function filterValue(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
