export type CompatibilityListQuery = Record<string, string>;

export function readCompatibilityListQuery(params: URLSearchParams, keys: readonly string[]): CompatibilityListQuery {
  return Object.fromEntries(keys.map((key) => [key, params.get(key)?.trim() ?? ""]));
}

export function buildCompatibilityListUrl(
  pathname: string,
  currentSearch: string,
  updates: Readonly<Record<string, string | null>>,
  clearKeys: readonly string[] = [],
) {
  const params = new URLSearchParams(currentSearch);
  for (const key of clearKeys) params.delete(key);
  for (const [key, value] of Object.entries(updates)) {
    const normalized = value?.trim();
    if (normalized) params.set(key, normalized);
    else params.delete(key);
  }
  return `${pathname}${params.size ? `?${params.toString()}` : ""}`;
}
