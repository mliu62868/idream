export type ContentQuery = {
  search: string;
  status: string;
  visibility: string;
  cursor: string;
};

export const defaultContentQuery: ContentQuery = {
  search: "",
  status: "",
  visibility: "",
  cursor: "",
};

export function contentQueryFromSearch(search: string): ContentQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("contentSearch") ?? "",
    status: params.get("contentStatus") ?? "",
    visibility: params.get("contentVisibility") ?? "",
    cursor: params.get("contentCursor") ?? "",
  };
}

export function contentListPath(query: ContentQuery) {
  const params = new URLSearchParams({ limit: "25" });
  set(params, "search", query.search);
  set(params, "status", query.status);
  set(params, "visibility", query.visibility);
  set(params, "cursor", query.cursor);
  return `/api/v1/admin/content/characters?${params.toString()}`;
}

export function contentWorkspaceUrl(
  pathname: string,
  search: string,
  query: ContentQuery,
) {
  const params = new URLSearchParams(search);
  set(params, "contentSearch", query.search);
  set(params, "contentStatus", query.status);
  set(params, "contentVisibility", query.visibility);
  set(params, "contentCursor", query.cursor);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
