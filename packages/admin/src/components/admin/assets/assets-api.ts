import {
  contentAssetAuthorityDependencySchema,
  contentAssetReviewStatusSchema,
  creativeRunPurposeSchema,
  platformAssetUploadPurposeSchema,
  type ContentAsset as SharedContentAsset,
  type ContentAssetAuthorityDependency,
  type ContentAssetBulkMutationResponse,
  type ContentAssetBulkPreflightResponse,
  type ContentAssetUploadResponse,
  type PlatformAssetUploadPurpose,
} from "@idream/shared/admin";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";

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
    case "comic_publication":
      return { detail: dependency.comicId, key: `${dependency.kind}:${dependency.comicId}`, title: "Submitted or published Comic" };
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

// 图片库筛选只展示已产出资产，但选项本身始终从 shared v2 契约派生。
export const ASSET_STATUSES = contentAssetReviewStatusSchema.options.filter(
  (status) => status !== "draft",
);
export const ASSET_PURPOSES = creativeRunPurposeSchema.options;
export const ASSET_UPLOAD_PURPOSES = platformAssetUploadPurposeSchema.options;

export async function uploadPlatformAsset(params: {
  file: File;
  purpose: PlatformAssetUploadPurpose;
  fallbackMessage?: string;
}): Promise<ContentAssetUploadResponse> {
  const form = new FormData();
  form.set("purpose", params.purpose);
  form.set("image", params.file);
  try {
    return await adminV2Operation("POST /api/v2/admin/assets", {
      // SPEC: 上传的意图由「哪个文件、做什么用」定义 —— form 不进签名，没有它两次不同的
      //       上传会共用一把键。
      intent: `${params.purpose}:${params.file.name}:${params.file.size}:${params.file.lastModified}`,
      form,
    });
  } catch (cause) {
    if (cause instanceof Error) throw cause;
    throw new Error(params.fallbackMessage ?? "Image upload failed");
  }
}

// SPEC: 列表页筛选走服务端查询参数（沿用 旧图片库视图 原有拼接方式，不改成客户端过滤——
// 资产量可观，服务端筛更省）；详情页复用同一构造但不传筛选，等价于裸端点（spec §7 详情页
// "无单条 GET，复用列表接口" 惯例的图片库版本——后端其实有单条 GET，但为与其余三件套架构一致
// 仍走 list+find）。
export function assetsListPath(filters?: { mediaType?: "image" | "video"; status?: string; purpose?: string; search?: string; targetId?: string; cursor?: string; limit?: number }): string {
  const params = new URLSearchParams();
  if (filters?.mediaType) params.set("mediaType", filters.mediaType);
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
    description: params.draft.description.trim(),
    reason: params.reason,
    confirmation: params.id,
  };
}

export type AssetArchiveBlocker =
  | { kind: "missing"; missingAssetIds: string[] }
  | {
      kind: "dependency";
      assetId?: string;
      dependencies: AssetAuthorityDependency[];
      repairPath?: string;
    };

export type AssetArchivePreflight = ContentAssetBulkPreflightResponse;
export type AssetArchivePreflightBlocker = AssetArchivePreflight["blockers"][number];

// INVARIANT: only an explicit authority rejection proves the batch was not changed.
// Transport errors keep their original status/code/requestId and never become a blocker.
export function assetArchiveBlocker(cause: unknown): AssetArchiveBlocker | null {
  if (!(cause instanceof AdminV2RequestError) || cause.outcome !== "answered" || typeof cause.details !== "object" || cause.details === null) return null;
  const record = cause.details as Record<string, unknown>;
  if (cause.status === 404 && Array.isArray(record.missingAssetIds)) {
    const missingAssetIds = record.missingAssetIds.filter((id): id is string => typeof id === "string" && id.length > 0);
    return missingAssetIds.length > 0 ? { kind: "missing", missingAssetIds } : null;
  }
  if (cause.status !== 409 || record.code !== "asset_authority_dependency_active") return null;
  return {
    kind: "dependency",
    assetId: typeof record.assetId === "string" ? record.assetId : undefined,
    dependencies: Array.isArray(record.dependencies)
      ? record.dependencies.flatMap((dependency) => {
          const parsed = contentAssetAuthorityDependencySchema.safeParse(dependency);
          return parsed.success ? [parsed.data] : [];
        })
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

export async function bulkArchiveAssets(params: {
  assetIds: readonly string[];
  reason: string;
}): Promise<ContentAssetBulkMutationResponse> {
  return adminV2Operation("POST /api/v2/admin/assets/bulk", {
    body: assetBulkArchivePayload(params),
  });
}

export async function preflightArchiveAssets(
  assetIds: readonly string[],
): Promise<AssetArchivePreflight> {
  return adminV2Operation("POST /api/v2/admin/assets/bulk/preflight", {
    body: { assetIds: canonicalAssetIds(assetIds) },
  });
}
