import type { GenerationJobSort } from "@idream/shared/admin";

export const GENERATION_JOBS_REFRESH_EVENT = "idream:generation-jobs-refresh";

export type GenerationJobQueryDraft = {
  search: string;
  mode: "all" | "image" | "video";
  legacyStatus: string;
  provider: string;
  sourceType: string;
  userId: string;
  characterId: string;
  sort: GenerationJobSort;
  limit: number;
  cursor?: string;
};

export const generationJobStatusOptions = [
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
  "completed",
  "failed",
  "blocked",
  "refunded",
  "cancelled",
] as const;

const sortOptions: GenerationJobSort[] = ["created_desc", "created_asc", "updated_desc", "cost_desc"];
const limitOptions = [10, 25, 50, 100];

export const defaultGenerationJobQuery: GenerationJobQueryDraft = {
  search: "",
  mode: "image",
  legacyStatus: "",
  provider: "",
  sourceType: "",
  userId: "",
  characterId: "",
  sort: "created_desc",
  limit: 25,
  cursor: undefined,
};

export function buildGenerationJobQuery(query: GenerationJobQueryDraft) {
  const params = new URLSearchParams();
  append(params, "search", query.search);
  params.set("mode", query.mode);
  append(params, "legacyStatus", query.legacyStatus);
  append(params, "provider", query.provider);
  append(params, "sourceType", query.sourceType);
  append(params, "userId", query.userId);
  append(params, "characterId", query.characterId);
  params.set("sort", query.sort);
  params.set("limit", String(query.limit));
  append(params, "cursor", query.cursor);
  return params.toString();
}

export function parseGenerationJobQuery(params: URLSearchParams): GenerationJobQueryDraft {
  const mode = params.get("mode");
  const legacyStatus = params.get("legacyStatus");
  const sort = params.get("sort") as GenerationJobSort | null;
  const limit = Number(params.get("limit"));
  return {
    search: params.get("search")?.trim() ?? "",
    mode: mode === "all" || mode === "video" ? mode : "image",
    legacyStatus: legacyStatus && generationJobStatusOptions.includes(legacyStatus as typeof generationJobStatusOptions[number]) ? legacyStatus : "",
    provider: params.get("provider")?.trim() ?? "",
    sourceType: params.get("sourceType")?.trim() ?? "",
    userId: params.get("userId")?.trim() ?? "",
    characterId: params.get("characterId")?.trim() ?? "",
    sort: sort && sortOptions.includes(sort) ? sort : "created_desc",
    limit: limitOptions.includes(limit) ? limit : 25,
    cursor: params.get("cursor")?.trim() || undefined,
  };
}

function append(params: URLSearchParams, key: string, value: string | undefined) {
  const normalized = value?.trim();
  if (normalized) params.set(key, normalized);
}
