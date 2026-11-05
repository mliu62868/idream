import {
  characterPortfolioWorkQueueSchema,
  characterServingStateSchema,
  type CharacterPortfolioQuery,
} from "@idream/shared/admin";

// INTENT: 角色列表只提供这四种时间/ID 排序；表现排序属于表现页，见 CharacterPerformanceBoard。
export type CharacterPortfolioSort = Extract<
  NonNullable<CharacterPortfolioQuery["sort"]>,
  "updated_desc" | "updated_asc" | "created_desc" | "project_id_asc"
>;
export type CharacterPortfolioWorkQueue = NonNullable<
  CharacterPortfolioQuery["workQueue"]
>;
export type CharacterPortfolioSource = NonNullable<CharacterPortfolioQuery["source"]>;
export type CharacterPortfolioEmptyView =
  | "all"
  | "filtered"
  | "attention"
  | CharacterPortfolioWorkQueue;

export interface CharacterPortfolioUrlState {
  readonly search: string;
  readonly servingState?: string;
  readonly attention?: boolean;
  readonly workQueue?: CharacterPortfolioWorkQueue;
  readonly source?: CharacterPortfolioSource;
  readonly sort?: CharacterPortfolioSort;
  readonly cursor?: string;
}

export const CHARACTER_PORTFOLIO_SERVING_STATES = characterServingStateSchema.options;

// SPEC: 排序选项与它们的运营文案。键取自契约的 sort 枚举 —— 契约增删一个值，这张表编译不过。
// INTENT: 这里曾无条件写死 sort=project_id_asc，因为契约当时只有这一个值；authority 扩容后
//         再不接出来，运营就只能按内部 ID 字典序看角色列表 —— 那个顺序对任何人都没有意义。
// INVARIANT: 顺序即下拉顺序。默认值必须与契约的 .default() 一致，否则第一屏的 URL 会和
//            后端的隐含排序对不上。
export const CHARACTER_PORTFOLIO_SORT_LABELS: Record<CharacterPortfolioSort, string> = {
  updated_desc: "Recently updated",
  updated_asc: "Least recently updated",
  created_desc: "Newest first",
  project_id_asc: "Character ID",
};

export const CHARACTER_PORTFOLIO_SORTS = Object.keys(
  CHARACTER_PORTFOLIO_SORT_LABELS,
) as readonly CharacterPortfolioSort[];

export const CHARACTER_PORTFOLIO_DEFAULT_SORT: CharacterPortfolioSort = "updated_desc";

/** 分页条要按同一个 limit 算「第几条–第几条」，所以它不能只活在下面的 URLSearchParams 里。 */
export const CHARACTER_PORTFOLIO_PAGE_SIZE = 25;

function optionalValue(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseSort(value: string | null): CharacterPortfolioSort | undefined {
  return CHARACTER_PORTFOLIO_SORTS.find((sort) => sort === value);
}

function parseWorkQueue(
  value: string | null,
): CharacterPortfolioWorkQueue | undefined {
  const parsed = characterPortfolioWorkQueueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseSource(value: string | null): CharacterPortfolioSource | undefined {
  return value === "official" || value === "user" ? value : undefined;
}

export function parseCharacterPortfolioUrl(search: string): CharacterPortfolioUrlState {
  const params = new URLSearchParams(search);
  const servingState = characterServingStateSchema.safeParse(params.get("servingState"));
  return {
    search: params.get("search")?.trim() ?? "",
    servingState: servingState.success ? servingState.data : undefined,
    attention: params.get("attention") === "true" ? true : undefined,
    workQueue: parseWorkQueue(params.get("workQueue")),
    source: parseSource(params.get("source")),
    sort: parseSort(params.get("sort")),
    cursor: optionalValue(params.get("cursor")),
  };
}

export function characterPortfolioQuery(
  state: CharacterPortfolioUrlState,
  includeAuthorityDefaults = false,
) {
  const params = new URLSearchParams();
  if (includeAuthorityDefaults) {
    params.set("limit", String(CHARACTER_PORTFOLIO_PAGE_SIZE));
    params.set("sort", state.sort ?? CHARACTER_PORTFOLIO_DEFAULT_SORT);
  } else if (state.sort) {
    // 地址栏只写运营自己选过的排序 —— 默认值不占位置，分享出去的链接才干净。
    params.set("sort", state.sort);
  }
  if (state.search.trim()) params.set("search", state.search.trim());
  if (state.servingState) params.set("servingState", state.servingState);
  if (state.attention) params.set("attention", "true");
  if (state.workQueue) params.set("workQueue", state.workQueue);
  if (state.source) params.set("source", state.source);
  if (state.cursor) params.set("cursor", state.cursor);
  return params.toString();
}

// SPEC: “问题已清空”只在运营清单本身为空时成立；一旦叠加搜索，零结果只说明组合筛选没命中。
// INTENT: admin 曾解析 ?readiness= 却没有任何 UI 入口 —— 隐形筛选，口径还和卡片的 unknown 不一致，已删除；
//         服务端参数保留，只是本页不再读写它。
export function characterPortfolioEmptyView(
  state: CharacterPortfolioUrlState,
): CharacterPortfolioEmptyView {
  if (state.search.trim()) return "filtered";
  if (state.attention) return "attention";
  if (state.workQueue) return state.workQueue;
  return state.servingState || state.source ? "filtered" : "all";
}

// SPEC: 地址栏之外、只属于请求的默认值。「全部」不含归档，归档有自己的视图；计数随列表一起取。
export function characterPortfolioRequestParams(state: CharacterPortfolioUrlState) {
  const params = new URLSearchParams(characterPortfolioQuery(state, true));
  if (state.servingState !== "retired") params.set("excludeArchived", "true");
  params.set("includeFacets", "true");
  return params;
}
