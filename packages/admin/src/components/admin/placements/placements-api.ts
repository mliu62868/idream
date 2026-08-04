// SPEC: 内容铺位（Placements）三件套的共享契约 —— 类型/端点/payload 构造（SSoT，三页共用）。
// INVARIANTS: payload 字段与旧内容运营视图的 POST（ContentOpsViews.tsx:536-543）/
// PATCH（:566-570）body 完全一致；placementCreateSchema/placementPatchSchema
// （server admin/content/placements.ts）都要求 reason（≥3 字符）—— 与 Recipes/Presets 不同，铺位的创建与状态
// 流转都走 ConfirmDialog/FormFooter 采集 reason（T14/T15 规则里"backend 收 reason"的分支，与
// Assets 图片库同款）。PATCH 还要求 confirmation===完整 placement id——由调用方用已知 id 自动
// 填充，不是运营手敲（真正需要手敲重复确认的只有 archive 这一步破坏性操作，走 ConfirmDialog 的
// destructive.expectedName）。

export type PlacementAsset = {
  id: string;
  url: string;
  thumbnailUrl: string;
};

export type Placement = {
  id: string;
  mediaAssetId: string;
  slot: string;
  targetType: string;
  targetId: string;
  status: string;
  version: number;
  publishedAt: string | null;
  verificationState: string;
  managedRunId: string | null;
  asset: PlacementAsset;
};

// 原样搬运 旧内容运营视图 New-placement 表单读取的资产字段——只取下拉框需要的 id/purpose/targetId。
export type ApprovedAsset = {
  id: string;
  purpose: string | null;
  targetId: string | null;
  customerPublishable: boolean;
  publishabilityReasons: string[];
};

export const PLACEMENTS_BASE = "/api/v1/admin/content/placements";
export const PLACEMENTS_LIST = `${PLACEMENTS_BASE}?limit=25`;
export const APPROVED_ASSETS_LIST = "/api/v2/admin/assets?status=approved&limit=100";

// 与 placementSlotSchema（server admin/content/placements.ts）一致。
export const SLOTS = [
  "feed_card",
  "homepage_strip",
  "seo_article",
  "template_cover",
  "campaign",
] as const;

// 与 productionTargetTypeSchema.exclude(["none"])（server admin/content/placements.ts）一致；沿用 旧内容运营视图
// 原有下拉顺序。
export const TARGET_TYPES = ["character", "template", "route_page", "campaign"] as const;

// 新建表单只创建非运行时 draft；发布权由 Character Release 或 Creative Run verification 持有。
export const CREATE_STATUSES = ["draft"] as const;

// Legacy 详情页只保留 pause/archive；archive 是终态。
export const PATCH_ACTIONS = ["paused", "archived"] as const;

// 列表页筛选覆盖 placementStatusSchema 全部取值（含流转动作到不了的 draft/scheduled）。
export const ALL_STATUSES = ["draft", "scheduled", "published", "paused", "archived"] as const;

export function placementsListPath(filters: { search?: string; status?: string; cursor?: string }) {
  const params = new URLSearchParams({ limit: "25" });
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.cursor) params.set("cursor", filters.cursor);
  return `${PLACEMENTS_BASE}?${params}`;
}

export type PlacementDraft = {
  mediaAssetId: string;
  slot: (typeof SLOTS)[number];
  targetType: (typeof TARGET_TYPES)[number];
  targetId: string;
  status: (typeof CREATE_STATUSES)[number];
  reason: string;
};

export const defaultPlacementDraft: PlacementDraft = {
  mediaAssetId: "",
  slot: "feed_card",
  targetType: "character",
  targetId: "",
  status: "draft",
  reason: "",
};

export function publishableApprovedAssets(
  assets: readonly ApprovedAsset[],
) {
  return assets.filter((asset) => asset.customerPublishable);
}

// SPEC: 原样搬运 create()（ContentOpsViews.tsx:536-543）的 POST body；reason 原逻辑硬编码为
// "Created from Placements"，现在改为 FormFooter 采集的真实原因。
export function placementCreatePayload(draft: PlacementDraft): Record<string, unknown> {
  return {
    mediaAssetId: draft.mediaAssetId,
    slot: draft.slot,
    targetType: draft.targetType,
    targetId: draft.targetId,
    status: draft.status,
    reason: draft.reason.trim(),
  };
}

// SPEC: 原样搬运 patchPlacement()（:566-570）的 PATCH body；reason 原逻辑硬编码为
// `${nextStatus} from Placements`，现在改为 ConfirmDialog 采集的真实原因；confirmation 自动填充
// 为完整 placement id（与原逻辑一致，不是运营手敲）。
export function placementPatchPayload(
  id: string,
  status: (typeof PATCH_ACTIONS)[number],
  reason: string,
): Record<string, unknown> {
  return { status, reason, confirmation: id };
}
