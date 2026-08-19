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

// SPEC: 下拉选项与筛选芯片共用同一份标签 —— 芯片上写的就是运营刚才在下拉里选的那几个字。
export const generationJobModeOptions = [
  { value: "all", label: "All historical records" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
] as const;

export const generationJobSortOptions = [
  { value: "created_desc", label: "Newest created" },
  { value: "created_asc", label: "Oldest created" },
  { value: "updated_desc", label: "Recently changed" },
  { value: "cost_desc", label: "Highest cost" },
] as const;

const sortOptions: GenerationJobSort[] = generationJobSortOptions.map((option) => option.value);
export const generationJobLimitOptions = [10, 25, 50, 100];
const limitOptions = generationJobLimitOptions;

export type GenerationJobFilterKey =
  | "search" | "mode" | "legacyStatus" | "provider" | "sourceType" | "userId" | "characterId" | "sort";

const filterKeys: GenerationJobFilterKey[] = [
  "search", "mode", "legacyStatus", "provider", "sourceType", "userId", "characterId", "sort",
];

// SPEC: 相对默认查询「改了哪几项」—— 折叠筛选面板后，芯片就是这张表。
// INTENT: 默认 mode=image 不是中性值，所以不能用「非空即生效」来判断；一律与默认查询逐项比。
// `reset` 是清掉这枚芯片要打的补丁：键是联合类型，TS 推不出来，只在这一处收敛。
export function changedGenerationJobFilters(query: GenerationJobQueryDraft) {
  return filterKeys
    .filter((key) => query[key] !== defaultGenerationJobQuery[key])
    .map((key) => ({
      key,
      value: String(query[key]),
      reset: { [key]: defaultGenerationJobQuery[key] } as Partial<GenerationJobQueryDraft>,
    }));
}

export function isGenerationJobQueryFiltered(query: GenerationJobQueryDraft) {
  return changedGenerationJobFilters(query).length > 0;
}

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
