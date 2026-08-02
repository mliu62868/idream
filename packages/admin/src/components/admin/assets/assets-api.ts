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

export type AssetAuthorityDependency =
  | {
      kind: "character_primary_image";
      characterId: string;
      repairPath: string;
    }
  | {
      kind: "character_project_draft";
      characterId: string;
      projectId: string;
      repairPath: string;
    }
  | {
      kind: "character_visual_identity";
      characterId: string;
      visualProfileId: string;
      repairPath: string;
    }
  | {
      kind: "character_reference_set";
      characterId: string;
      visualProfileId: string;
      referenceSetRevisionId: string;
      repairPath: string;
    }
  | {
      kind: "character_generation_job";
      characterId: string | null;
      generationJobId: string;
      runId: string | null;
      repairPath: string;
    }
  | {
      kind: "character_look";
      characterId: string;
      lookId: string;
      status: string;
      repairPath: string;
    }
  | {
      kind: "creative_run_asset";
      runId: string;
      itemId: string;
      status: string;
      characterId: string | null;
      repairPath: string;
    }
  | {
      kind: "character_release";
      characterId: string;
      releaseId: string;
      releaseState: "current" | "scheduled";
      slot: string;
      repairPath: string;
    }
  | {
      kind: "verified_campaign" | "placement_verification";
      placementId: string;
      runId: string | null;
      targetId: string;
      repairPath: string;
    };

export type ContentAsset = {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string;
  isSynthetic: boolean;
  customerPublishable: boolean;
  publishabilityReasons: string[];
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
  placements: Array<{
    id: string;
    slot: string;
    targetType: string;
    targetId: string;
    status: string;
    publishedAt: string | null;
  }>;
  authorityDependencies?: AssetAuthorityDependency[];
};

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

export const ASSETS_LIST = "/api/v1/admin/content/assets";
export const ASSETS_BULK = `${ASSETS_LIST}/bulk`;
export const ASSETS_BULK_PREFLIGHT = `${ASSETS_BULK}/preflight`;

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

export type AssetArchivePreflightBlocker = {
  assetId: string;
  dependencies: AssetAuthorityDependency[];
};

export type AssetArchivePreflight = {
  assetIds: string[];
  blockers: AssetArchivePreflightBlocker[];
};

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

type AssetBulkArchiveEnvelope =
  | { ok: true; data: { updatedIds: string[] } }
  | {
      ok: false;
      error: {
        code?: string;
        message?: string;
        details?: unknown;
      };
    };

export async function bulkArchiveAssets(params: {
  assetIds: readonly string[];
  reason: string;
}): Promise<{ updatedIds: string[] }> {
  const response = await fetch(ASSETS_BULK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(assetBulkArchivePayload(params)),
  });
  const payload = await response.json() as AssetBulkArchiveEnvelope;
  if (!payload.ok) {
    throw new AssetBulkArchiveError(
      payload.error.message ?? payload.error.code ?? "Bulk archive failed",
      payload.error.details,
    );
  }
  return payload.data;
}

type AssetArchivePreflightEnvelope =
  | { ok: true; data: AssetArchivePreflight }
  | {
      ok: false;
      error: {
        code?: string;
        message?: string;
        details?: unknown;
      };
    };

export async function preflightArchiveAssets(
  assetIds: readonly string[],
): Promise<AssetArchivePreflight> {
  const canonicalIds = canonicalAssetIds(assetIds);
  const response = await fetch(ASSETS_BULK_PREFLIGHT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetIds: canonicalIds }),
  });
  const payload = await response.json() as AssetArchivePreflightEnvelope;
  if (!payload.ok) {
    throw new AssetBulkArchiveError(
      payload.error.message ?? payload.error.code ?? "Bulk archive preflight failed",
      payload.error.details,
    );
  }
  return payload.data;
}
