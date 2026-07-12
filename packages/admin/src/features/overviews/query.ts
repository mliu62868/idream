export type OverviewScope = "analytics" | "risk" | "provider";
export type OverviewQuery = { from: string; to: string };

export function overviewQueryFromSearch(
  search: string,
  scope: OverviewScope,
): OverviewQuery {
  const params = new URLSearchParams(search);
  return {
    from: params.get(`${scope}From`) ?? "",
    to: params.get(`${scope}To`) ?? "",
  };
}

export function overviewPath(path: string, query: OverviewQuery) {
  const params = new URLSearchParams();
  set(params, "from", query.from);
  set(params, "to", query.to);
  const value = params.toString();
  return value ? `${path}?${value}` : path;
}

export function overviewWorkspaceUrl(
  pathname: string,
  search: string,
  scope: OverviewScope,
  query: OverviewQuery,
) {
  const params = new URLSearchParams(search);
  set(params, `${scope}From`, query.from);
  set(params, `${scope}To`, query.to);
  const value = params.toString();
  return value ? `${pathname}?${value}` : pathname;
}

function set(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
