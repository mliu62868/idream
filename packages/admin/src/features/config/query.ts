export type GenerationConfigQuery = {
  search: string;
  profileMode: string;
  profileStatus: string;
  flagEnabled: string;
  profileCursor: string;
  flagCursor: string;
  tab: "profiles" | "settings";
};

export const defaultGenerationConfigQuery: GenerationConfigQuery = {
  search: "",
  profileMode: "",
  profileStatus: "",
  flagEnabled: "",
  profileCursor: "",
  flagCursor: "",
  tab: "profiles",
};

export function generationConfigQueryFromSearch(search: string): GenerationConfigQuery {
  const params = new URLSearchParams(search);
  return {
    search: params.get("configSearch") ?? "",
    profileMode: params.get("profileMode") ?? "",
    profileStatus: params.get("profileStatus") ?? "",
    flagEnabled: params.get("flagEnabled") ?? "",
    profileCursor: params.get("profileCursor") ?? "",
    flagCursor: params.get("flagCursor") ?? "",
    tab: params.get("tab") === "settings" ? "settings" : "profiles",
  };
}

export function generationProfilesPath(query: GenerationConfigQuery) {
  return withQuery("/api/v2/admin/generation/model-profiles", {
    search: query.search,
    mode: query.profileMode,
    status: query.profileStatus,
    cursor: query.profileCursor,
    limit: "25",
  });
}

export function featureFlagsPath(query: GenerationConfigQuery) {
  return withQuery("/api/v2/admin/feature-flags", {
    search: query.search,
    enabled: query.flagEnabled,
    cursor: query.flagCursor,
    limit: "25",
  });
}

export function generationConfigWorkspaceUrl(pathname: string, search: string, query: GenerationConfigQuery) {
  const params = new URLSearchParams(search);
  setOrDelete(params, "configSearch", query.search);
  setOrDelete(params, "profileMode", query.profileMode);
  setOrDelete(params, "profileStatus", query.profileStatus);
  setOrDelete(params, "flagEnabled", query.flagEnabled);
  setOrDelete(params, "profileCursor", query.profileCursor);
  setOrDelete(params, "flagCursor", query.flagCursor);
  setOrDelete(params, "tab", query.tab === "settings" ? "settings" : "");
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

export function isGenerationConfigQueryFiltered(query: GenerationConfigQuery) {
  return Boolean(query.search || query.profileMode || query.profileStatus || query.flagEnabled);
}

function withQuery(path: string, values: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) setOrDelete(params, key, value);
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
