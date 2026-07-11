import {
  savedViewQueryStateSchema,
  type CollaborationTargetType,
  type SavedViewQueryState,
} from "@idream/shared/admin";
import type { CaseQueryDraft } from "@/features/cases/query";
import type { IncidentQueryDraft } from "@/features/incidents/query";

export type SavedViewRecord = {
  id: string;
  scope: CollaborationTargetType;
  label: string;
  queryState: SavedViewQueryState;
  version: number;
  createdAt: string;
  updatedAt: string;
};

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

export const savedViewListSchema = { parse: parseSavedViewList };
export const savedViewMutationSchema = { parse: parseSavedViewMutation };

function parseSavedViewList(value: unknown): { items: SavedViewRecord[] } {
  const record = asRecord(value);
  if (!Array.isArray(record.items)) throw new Error("Saved View authority returned an invalid list");
  return { items: record.items.map(parseSavedView) };
}

function parseSavedViewMutation(value: unknown): { view: SavedViewRecord; duplicate: boolean } {
  const record = asRecord(value);
  if (typeof record.duplicate !== "boolean") throw new Error("Saved View authority returned an invalid mutation response");
  return { view: parseSavedView(record.view), duplicate: record.duplicate };
}

function parseSavedView(value: unknown): SavedViewRecord {
  const record = asRecord(value);
  if (typeof record.id !== "string" || !["character_project", "creative_run", "case", "incident"].includes(String(record.scope)) || typeof record.label !== "string" || !Number.isInteger(record.version) || Number(record.version) < 1 || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("Saved View authority returned an invalid record");
  }
  return {
    id: record.id,
    scope: record.scope as CollaborationTargetType,
    label: record.label,
    queryState: savedViewQueryStateSchema.parse(record.queryState),
    version: Number(record.version),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function allowedFilter(value: unknown, allowed: readonly string[], fallback = "") {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function stringFilter(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved View authority returned an invalid response");
  return value as Record<string, unknown>;
}
