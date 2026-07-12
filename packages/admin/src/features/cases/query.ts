export type CaseQueryDraft = {
  view: string;
  search: string;
  type: string;
  status: string;
  priority: string;
  ownerId: string;
  sort: "updated_desc" | "updated_asc";
  cursor?: string;
  limit: number;
};

export const caseViews = ["mine", "unassigned", "overdue", "appeals", "recently_resolved", "all"] as const;

export const defaultCaseQuery: CaseQueryDraft = {
  view: "mine",
  search: "",
  type: "",
  status: "",
  priority: "",
  ownerId: "",
  sort: "updated_desc",
  limit: 30,
};

export type CaseWorkspaceUrlState = {
  query: CaseQueryDraft;
  selectedId: string | null;
  savedViewId: string | null;
};

export function buildCaseQuery(query: CaseQueryDraft) {
  const params = new URLSearchParams();
  append(params, "view", query.view);
  append(params, "search", query.search);
  append(params, "type", query.type);
  append(params, "status", query.status);
  append(params, "priority", query.priority);
  append(params, "ownerId", query.ownerId);
  append(params, "sort", query.sort);
  append(params, "cursor", query.cursor);
  params.set("limit", String(query.limit));
  return params.toString();
}

export function buildCaseWorkspaceParams(state: CaseWorkspaceUrlState) {
  const params = new URLSearchParams(buildCaseQuery(state.query));
  append(params, "case", state.selectedId ?? undefined);
  append(params, "savedView", state.savedViewId ?? undefined);
  return params;
}

export function caseWorkspacePath(selectedId: string | null) {
  return selectedId ? `/admin/cases/${encodeURIComponent(selectedId)}` : "/admin/cases";
}

export function parseCaseWorkspaceParams(params: URLSearchParams): CaseWorkspaceUrlState {
  const view = params.get("view");
  const sort = params.get("sort");
  return {
    query: {
      ...defaultCaseQuery,
      view: caseViews.includes(view as (typeof caseViews)[number]) ? view ?? defaultCaseQuery.view : defaultCaseQuery.view,
      search: params.get("search") ?? "",
      type: params.get("type") ?? "",
      status: params.get("status") ?? "",
      priority: params.get("priority") ?? "",
      ownerId: params.get("ownerId") ?? "",
      sort: sort === "updated_asc" ? "updated_asc" : "updated_desc",
      cursor: normalized(params.get("cursor")),
      limit: boundedLimit(params.get("limit"), defaultCaseQuery.limit),
    },
    selectedId: normalized(params.get("case")) ?? null,
    savedViewId: normalized(params.get("savedView")) ?? null,
  };
}

function append(params: URLSearchParams, key: string, value: string | undefined) {
  const normalized = value?.trim();
  if (normalized) params.set(key, normalized);
}

function normalized(value: string | null) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function boundedLimit(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 200 ? parsed : fallback;
}
