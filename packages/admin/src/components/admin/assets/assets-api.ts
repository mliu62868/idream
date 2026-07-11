// SPEC: 图片库两件套（列表 + 详情，无 /new）共享契约 —— 类型/端点/查询参数拼接/审核 PATCH body
// 构造（SSoT，两页共用）。
// INVARIANTS: assetPatchSchema（content-ops.ts:90-97）要求 reason（≥3 字符，trim 后）且
// confirmation===完整 id —— 与 Recipes/Presets（PATCH 无 reason，直连 apiWrite）不同，图片库的
// 审核/保存写操作都要走 ConfirmDialog 采集 reason（T14/T15 规则里"backend 收 reason"的分支）。

export type AssetSourceJob = {
  id: string;
  status: string;
  profileId: string | null;
  profileVersion: number | null;
  recipeId: string | null;
  recipeVersion: number | null;
};

export type AssetSourceBatch = {
  id: string;
  title: string;
  purpose: string;
  status: string;
};

export type ContentAsset = {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
  safetyStatus: string;
  sourceJobId: string | null;
  createdAt: string;
  platformStatus: string;
  purpose: string | null;
  targetType: string | null;
  targetId: string | null;
  tags: string[];
  description: string | null;
  sourceJob: AssetSourceJob | null;
  sourceBatch: AssetSourceBatch | null;
};

export const ASSETS_LIST = "/api/v1/admin/content/assets";

// 与后端 assetReviewStatusSchema 一致，但排除 "draft"——图片库筛选历来只覆盖已产出的资产
// （沿用 旧图片库视图 原有的筛选项，未新增未删减）。
export const ASSET_STATUSES = ["generated", "approved", "rejected", "published", "archived"] as const;

// 与后端 productionPurposeSchema 一致；ProductionStudioView（ContentOpsViews.tsx）另有一份同值
// 本地常量——两个模块故意不共享同一个源（各 -api.ts 自成 SSoT 是本次重设计三件套的既有约定，
// ProductionStudioView 本次不改动）。
export const ASSET_PURPOSES = [
  "character_cover",
  "character_hero",
  "character_chat",
  "feed",
  "homepage",
  "seo",
  "template_cover",
  "campaign",
  "model_eval",
] as const;

// SPEC: 列表页筛选走服务端查询参数（沿用 旧图片库视图 原有拼接方式，不改成客户端过滤——
// 资产量可观，服务端筛更省）；详情页复用同一构造但不传筛选，等价于裸端点（spec §7 详情页
// "无单条 GET，复用列表接口" 惯例的图片库版本——后端其实有单条 GET，但为与其余三件套架构一致
// 仍走 list+find）。
export function assetsListPath(filters?: { status?: string; purpose?: string }): string {
  const params = new URLSearchParams();
  if (filters?.status && filters.status !== "all") params.set("status", filters.status);
  if (filters?.purpose && filters.purpose !== "all") params.set("purpose", filters.purpose);
  return params.size > 0 ? `${ASSETS_LIST}?${params.toString()}` : ASSETS_LIST;
}

// SPEC: 标签输入框（逗号分隔）→ 去空白去空项数组（从 ContentOpsViews.tsx 的 旧图片库视图
// 迁入，行为不变）。
export function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export type AssetDraft = {
  tags: string;
  description: string;
};

export function draftFromAsset(asset: ContentAsset): AssetDraft {
  return { tags: asset.tags.join(", "), description: asset.description ?? "" };
}

// SPEC: 审核/保存 PATCH body —— 原样搬运 旧图片库视图 的 patchAsset(:540)/saveAssetMetadata(:561)
// 构造：status 缺省时省略（JSON.stringify 丢弃 undefined 键，等价于 saveAssetMetadata 原本压根不带
// status 字段）。reason 与 confirmation 现在来自 ConfirmDialog 采集的真实原因 + 资产完整 id——
// UI 侧展示的短 id（前 8 位）只用于 ConfirmDialog 的"输入名称确认"环节，不是发给后端的 confirmation。
export function assetPatchPayload(params: {
  id: string;
  draft: AssetDraft;
  reason: string;
  status?: (typeof ASSET_STATUSES)[number];
}): Record<string, unknown> {
  return {
    status: params.status,
    tags: splitTags(params.draft.tags),
    description: params.draft.description.trim() || undefined,
    reason: params.reason,
    confirmation: params.id,
  };
}
