export type CaseQueryDraft = {
  view: string;
  search: string;
  type: string;
  status: string;
  priority: string;
  ownerId: string;
  cursor?: string;
  limit: number;
};

export function buildCaseQuery(query: CaseQueryDraft) {
  const params = new URLSearchParams();
  append(params, "view", query.view);
  append(params, "search", query.search);
  append(params, "type", query.type);
  append(params, "status", query.status);
  append(params, "priority", query.priority);
  append(params, "ownerId", query.ownerId);
  append(params, "cursor", query.cursor);
  params.set("limit", String(query.limit));
  return params.toString();
}

function append(params: URLSearchParams, key: string, value: string | undefined) {
  const normalized = value?.trim();
  if (normalized) params.set(key, normalized);
}
