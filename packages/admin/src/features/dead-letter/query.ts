export type DeadLetterQuery = {
  search: string;
  mode: string;
  status: string;
  errorCode: string;
  cursor: string;
};

export const defaultDeadLetterQuery: DeadLetterQuery = {
  search: "",
  mode: "",
  status: "",
  errorCode: "",
  cursor: "",
};

export function deadLetterQueryFromSearch(search: string): DeadLetterQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("deadSearch") ?? "",
    mode: params.get("deadMode") ?? "",
    status: params.get("deadStatus") ?? "",
    errorCode: params.get("deadError") ?? "",
    cursor: params.get("deadCursor") ?? "",
  };
}

export function deadLetterListPath(query: DeadLetterQuery) {
  const params = new URLSearchParams();
  setOrDelete(params, "search", query.search);
  setOrDelete(params, "mode", query.mode);
  setOrDelete(params, "status", query.status);
  setOrDelete(params, "errorCode", query.errorCode);
  setOrDelete(params, "cursor", query.cursor);
  params.set("limit", "25");
  return `/api/v1/admin/generation/dead-letter?${params.toString()}`;
}

export function deadLetterWorkspaceUrl(pathname: string, search: string, query: DeadLetterQuery) {
  const params = new URLSearchParams(search);
  setOrDelete(params, "deadSearch", query.search);
  setOrDelete(params, "deadMode", query.mode);
  setOrDelete(params, "deadStatus", query.status);
  setOrDelete(params, "deadError", query.errorCode);
  setOrDelete(params, "deadCursor", query.cursor);
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

export function deadLetterConfirmation(jobIds: readonly string[]) {
  return jobIds.join(",");
}

export function isDeadLetterQueryFiltered(query: DeadLetterQuery) {
  return Boolean(query.search || query.mode || query.status || query.errorCode);
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
