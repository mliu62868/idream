import {
  savedViewListResponseSchema,
  savedViewMutationResponseSchema,
  type SavedView,
  type SavedViewQueryState,
} from "@idream/shared/admin";
import type { CaseQueryDraft } from "@/features/cases/query";
import type { IncidentQueryDraft } from "@/features/incidents/query";

export type SavedViewRecord = SavedView;

export function applySavedView(
  view: SavedViewRecord,
  onSelectedChange: (id: string | null) => void,
  onApply: (view: SavedViewRecord) => void,
) {
  onSelectedChange(view.id);
  onApply(view);
}

export function withoutSavedViewParam(search: string) {
  const params = new URLSearchParams(search);
  params.delete("savedView");
  return params;
}

export function incidentSavedState(query: IncidentQueryDraft): SavedViewQueryState {
  return {
    search: query.search,
    filters: { status: query.status, severity: query.severity, ownerId: query.ownerId },
    sort: { field: "id", direction: "asc" },
    pageSize: query.limit,
  };
}

export function incidentQueryFromSavedState(state: SavedViewQueryState): IncidentQueryDraft {
  return {
    search: state.search,
    status: allowedFilter(state.filters.status, ["", "detected", "triaged", "mitigating", "monitoring", "resolved", "closed"]),
    severity: allowedFilter(state.filters.severity, ["", "critical", "high", "medium", "low"]),
    ownerId: stringFilter(state.filters.ownerId),
    limit: state.pageSize,
  };
}

export function caseSavedState(query: CaseQueryDraft): SavedViewQueryState {
  return {
    search: query.search,
    filters: { view: query.view, type: query.type, status: query.status, priority: query.priority, ownerId: query.ownerId },
    sort: { field: "updated_at", direction: query.sort === "updated_asc" ? "asc" : "desc" },
    pageSize: query.limit,
  };
}

export function caseQueryFromSavedState(state: SavedViewQueryState): CaseQueryDraft {
  return {
    view: allowedFilter(state.filters.view, ["mine", "unassigned", "overdue", "appeals", "recently_resolved", "all"], "mine"),
    search: state.search,
    type: allowedFilter(state.filters.type, ["", "content_report", "appeal", "support_request", "billing_dispute"]),
    status: allowedFilter(state.filters.status, ["", "new", "triaged", "in_progress", "waiting", "resolved", "closed", "reopened"]),
    priority: allowedFilter(state.filters.priority, ["", "urgent", "high", "normal", "low"]),
    ownerId: stringFilter(state.filters.ownerId),
    sort: state.sort.field === "updated_at" && state.sort.direction === "asc" ? "updated_asc" : "updated_desc",
    limit: state.pageSize,
  };
}

export const savedViewListSchema = savedViewListResponseSchema;
export const savedViewMutationSchema = savedViewMutationResponseSchema;

function allowedFilter(value: unknown, allowed: readonly string[], fallback = "") {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function stringFilter(value: unknown) {
  return typeof value === "string" ? value : "";
}
