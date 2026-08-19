import {
  contentAssetReviewStatusSchema,
  creativeRunPurposeSchema,
  type ContentAsset as SharedContentAsset,
  type ContentAssetAuthorityDependency,
  type ContentAssetBulkMutationResponse,
  type ContentAssetBulkPreflightResponse,
} from "@idream/shared/admin";
import type { ApiEnvelope } from "../api";

// SPEC: 图片库列表、详情和批量归档只消费 shared manifest 声明的 v2 Asset 契约；
// 页面本地只保留展示与交互类型，不复制跨包协议。
export type ContentAsset = SharedContentAsset;
export type AssetAuthorityDependency = ContentAssetAuthorityDependency;
export type AssetSourceJob = NonNullable<ContentAsset["sourceJob"]>;
export type AssetSourceBatch = NonNullable<ContentAsset["sourceBatch"]>;
export function assetAuthorityDependencyView(
  dependency: AssetAuthorityDependency,
): { detail: string; key: string; title: string } {
  switch (dependency.kind) {
    case "character_primary_image":
      return {
        detail: dependency.characterId,
        key: `${dependency.kind}:${dependency.characterId}`,
        title: "Character primary image",
      };
    case "character_project_draft":
      return {
        detail: `${dependency.characterId} · ${dependency.projectId}`,
        key: `${dependency.kind}:${dependency.projectId}`,
        title: "Character project draft",
      };
    case "character_visual_identity":
      return {
        detail: `${dependency.characterId} · ${dependency.visualProfileId}`,
        key: `${dependency.kind}:${dependency.visualProfileId}`,
        title: "Active visual identity",
      };
    case "character_reference_set":
      return {
        detail: `${dependency.characterId} · ${dependency.referenceSetRevisionId}`,
        key: `${dependency.kind}:${dependency.referenceSetRevisionId}`,
        title: "Published character reference set",
      };
    case "character_generation_job":
      return {
        detail: dependency.characterId
          ? `${dependency.characterId} · ${dependency.generationJobId}`
          : dependency.generationJobId,
        key: `${dependency.kind}:${dependency.generationJobId}`,
        title: "Active character generation job",
      };
    case "character_look":
      return {
        detail: `${dependency.status} · ${dependency.characterId} · ${dependency.lookId}`,
        key: `${dependency.kind}:${dependency.lookId}`,
        title: "Active character look",
      };
    case "creative_run_asset":
      return {
        detail: `${dependency.status} · ${dependency.runId} · ${dependency.itemId}`,
        key: `${dependency.kind}:${dependency.itemId}`,
        title: "Creative Run asset in use",
      };
    case "character_release":
      return {
        detail: `${dependency.slot} · ${dependency.releaseId}`,
        key: `${dependency.kind}:${dependency.releaseState}:${dependency.releaseId}:${dependency.slot}`,
        title: dependency.releaseState === "scheduled"
          ? "Scheduled Character Release"
          : "Current Character Release",
      };
    case "verified_campaign":
      return {
        detail: `${dependency.targetId} · ${dependency.placementId}`,
        key: `${dependency.kind}:${dependency.placementId}`,
        title: "Verified live campaign",
      };
    case "placement_verification":
      return {
        detail: `${dependency.targetId} · ${dependency.placementId}`,
        key: `${dependency.kind}:${dependency.placementId}`,
        title: "Campaign verification in progress",
      };
  }
}

export const ASSETS_LIST = "/api/v2/admin/assets";
export const ASSETS_BULK = `${ASSETS_LIST}/bulk`;
export const ASSETS_BULK_PREFLIGHT = `${ASSETS_BULK}/preflight`;

// 图片库筛选只展示已产出资产，但选项本身始终从 shared v2 契约派生。
export const ASSET_STATUSES = contentAssetReviewStatusSchema.options.filter(
  (status) => status !== "draft",
);
export const ASSET_PURPOSES = creativeRunPurposeSchema.options;

// SPEC: 列表页筛选走服务端查询参数（沿用 旧图片库视图 原有拼接方式，不改成客户端过滤——
// 资产量可观，服务端筛更省）；详情页复用同一构造但不传筛选，等价于裸端点（spec §7 详情页
// "无单条 GET，复用列表接口" 惯例的图片库版本——后端其实有单条 GET，但为与其余三件套架构一致
// 仍走 list+find）。
export function assetsListPath(filters?: { status?: string; purpose?: string; search?: string; targetId?: string; cursor?: string; limit?: number }): string {
  const params = new URLSearchParams();
  if (filters?.status && filters.status !== "all") params.set("status", filters.status);
  if (filters?.purpose && filters.purpose !== "all") params.set("purpose", filters.purpose);
  if (filters?.search?.trim()) params.set("search", filters.search.trim());
  // SPEC: targetId 把图库收敛到某个角色（生产批次的 targetId 即 characterId）。
  // INTENT: 角色工作台的"查看全部"要能落到这个角色的全部图片；后端一直支持该参数。
  if (filters?.targetId?.trim()) params.set("targetId", filters.targetId.trim());
  if (filters?.cursor) params.set("cursor", filters.cursor);
  if (filters?.limit) params.set("limit", String(filters.limit));
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
  status?: "archived";
}): Record<string, unknown> {
  if (params.status === "archived") {
    return {
      status: "archived",
      reason: params.reason,
      confirmation: params.id,
    };
  }
  return {
    status: params.status,
    tags: splitTags(params.draft.tags),
    description: params.draft.description.trim() || undefined,
    reason: params.reason,
    confirmation: params.id,
  };
}

export type AssetBulkArchiveErrorDetails = {
  code?: string;
  assetId?: string;
  dependencies: AssetAuthorityDependency[];
  missingAssetIds: string[];
  repairPath?: string;
};

export type AssetArchivePreflight = ContentAssetBulkPreflightResponse;
export type AssetArchivePreflightBlocker = AssetArchivePreflight["blockers"][number];

export class AssetBulkArchiveError extends Error {
  readonly details: AssetBulkArchiveErrorDetails;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "AssetBulkArchiveError";
    this.details = assetBulkArchiveErrorDetails(details);
  }
}

const ASSET_AUTHORITY_DEPENDENCY_KINDS = new Set<AssetAuthorityDependency["kind"]>([
  "character_primary_image",
  "character_project_draft",
  "character_visual_identity",
  "character_reference_set",
  "character_generation_job",
  "character_look",
  "creative_run_asset",
  "character_release",
  "verified_campaign",
  "placement_verification",
]);

function isAssetAuthorityDependency(value: unknown): value is AssetAuthorityDependency {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string"
    && ASSET_AUTHORITY_DEPENDENCY_KINDS.has(record.kind as AssetAuthorityDependency["kind"])
    && typeof record.repairPath === "string";
}

function assetBulkArchiveErrorDetails(value: unknown): AssetBulkArchiveErrorDetails {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    assetId: typeof record.assetId === "string" ? record.assetId : undefined,
    dependencies: Array.isArray(record.dependencies)
      ? record.dependencies.filter(isAssetAuthorityDependency)
      : [],
    missingAssetIds: Array.isArray(record.missingAssetIds)
      ? record.missingAssetIds.filter((id): id is string => typeof id === "string")
      : [],
    repairPath: typeof record.repairPath === "string" ? record.repairPath : undefined,
  };
}

export function canonicalAssetIds(assetIds: readonly string[]): string[] {
  return [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))].sort();
}

export function assetBulkArchivePayload(params: {
  assetIds: readonly string[];
  reason: string;
}): {
  assetIds: string[];
  confirmation: string;
  reason: string;
  status: "archived";
} {
  const assetIds = canonicalAssetIds(params.assetIds);
  return {
    assetIds,
    status: "archived",
    reason: params.reason.trim(),
    confirmation: assetIds.join(","),
  };
}

// INTENT: fallbackMessage 由调用方注入 —— 这是模块级函数，拿不到 t()；服务端连 message 和
// code 都没给时，硬编码的英文兜底会在中文 locale 直接露馅。
export async function bulkArchiveAssets(params: {
  assetIds: readonly string[];
  reason: string;
  fallbackMessage?: string;
}): Promise<{ updatedIds: string[] }> {
  const response = await fetch(ASSETS_BULK, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(assetBulkArchivePayload(params)),
  });
  const payload = await response.json() as ApiEnvelope<ContentAssetBulkMutationResponse>;
  if (!payload.ok) {
    throw new AssetBulkArchiveError(
      payload.error.message ?? payload.error.code ?? params.fallbackMessage ?? "Bulk archive failed",
      payload.error.details,
    );
  }
  return payload.data;
}

export async function preflightArchiveAssets(
  assetIds: readonly string[],
  fallbackMessage?: string,
): Promise<AssetArchivePreflight> {
  const canonicalIds = canonicalAssetIds(assetIds);
  const response = await fetch(ASSETS_BULK_PREFLIGHT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetIds: canonicalIds }),
  });
  const payload = await response.json() as ApiEnvelope<ContentAssetBulkPreflightResponse>;
  if (!payload.ok) {
    throw new AssetBulkArchiveError(
      payload.error.message ?? payload.error.code ?? fallbackMessage ?? "Bulk archive preflight failed",
      payload.error.details,
    );
  }
  return payload.data;
}
