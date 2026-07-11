export type IncidentQueryDraft = {
  search: string;
  status: string;
  severity: string;
  ownerId: string;
  cursor?: string;
  limit: number;
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

function append(params: URLSearchParams, key: string, value: string | undefined) {
  const normalized = value?.trim();
  if (normalized) params.set(key, normalized);
}
