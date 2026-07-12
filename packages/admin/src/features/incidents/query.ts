export type IncidentQueryDraft = {
  search: string;
  status: string;
  severity: string;
  ownerId: string;
  cursor?: string;
  limit: number;
};

export const defaultIncidentQuery: IncidentQueryDraft = {
  search: "",
  status: "",
  severity: "",
  ownerId: "",
  limit: 30,
};

export type IncidentWorkspaceUrlState = {
  query: IncidentQueryDraft;
  selectedId: string | null;
  savedViewId: string | null;
};

export function buildIncidentQuery(query: IncidentQueryDraft) {
  const params = new URLSearchParams();
  append(params, "search", query.search);
  append(params, "status", query.status);
  append(params, "severity", query.severity);
  append(params, "ownerId", query.ownerId);
  append(params, "cursor", query.cursor);
  params.set("limit", String(query.limit));
  return params.toString();
}

export function buildIncidentWorkspaceParams(state: IncidentWorkspaceUrlState) {
  const params = new URLSearchParams(buildIncidentQuery(state.query));
  append(params, "incident", state.selectedId ?? undefined);
  append(params, "savedView", state.savedViewId ?? undefined);
  return params;
}

export function incidentWorkspacePath(selectedId: string | null) {
  return selectedId ? `/admin/ops/incidents/${encodeURIComponent(selectedId)}` : "/admin/ops/incidents";
}

export function parseIncidentWorkspaceParams(params: URLSearchParams): IncidentWorkspaceUrlState {
  return {
    query: {
      ...defaultIncidentQuery,
      search: params.get("search") ?? "",
      status: params.get("status") ?? "",
      severity: params.get("severity") ?? "",
      ownerId: params.get("ownerId") ?? "",
      cursor: normalized(params.get("cursor")),
      limit: boundedLimit(params.get("limit"), defaultIncidentQuery.limit),
    },
    selectedId: normalized(params.get("incident")) ?? null,
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
