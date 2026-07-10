// SPEC: 官方角色三件套的共享契约 —— 类型/端点/payload 构造（SSoT，三页共用）。
// INVARIANTS: payload 字段与旧官方角色单页视图的 POST/PATCH body 完全一致（后端不变）。

export type OfficialStats = {
  chatsCount: number;
  likesCount: number;
  viewsCount: number;
} | null;

export type OfficialRow = {
  id: string;
  name: string;
  age: number;
  description: string;
  gender: string;
  style: string;
  status: string;
  visibility: string;
  createdAt: string;
  tags: string[];
  stats: OfficialStats;
  visualProfile: {
    id: string;
    version: number;
    status: string;
    style: string;
    anchorAssetIds?: unknown;
    referenceAssetIds?: unknown;
  } | null;
};

export const GENDERS = ["female", "male", "trans"] as const;
export const STYLES = ["realistic", "anime", "hybrid", "other"] as const;
export const OFFICIAL_LIST = "/api/v1/admin/content/official";

export type OfficialDraft = {
  name: string;
  age: string;
  gender: (typeof GENDERS)[number];
  style: (typeof STYLES)[number];
  description: string;
  tags: string;
  reason: string;
};

export function officialPayload(draft: OfficialDraft): Record<string, unknown> {
  const parsedAge = Number.parseInt(draft.age.trim(), 10);
  return {
    name: draft.name.trim(),
    age: Number.isFinite(parsedAge) ? parsedAge : 18,
    gender: draft.gender,
    style: draft.style,
    description: draft.description.trim(),
    tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    reason: draft.reason.trim(),
  };
}

export function visualReferenceCount(row: OfficialRow): number {
  const anchorCount = Array.isArray(row.visualProfile?.anchorAssetIds)
    ? row.visualProfile.anchorAssetIds.length
    : 0;
  const referenceCount = Array.isArray(row.visualProfile?.referenceAssetIds)
    ? row.visualProfile.referenceAssetIds.length
    : 0;
  return anchorCount + referenceCount;
}

export type ThumbAsset = {
  targetType: string | null;
  targetId: string | null;
  thumbnailUrl?: string | null;
  url?: string | null;
};

export function characterThumbnails(assets: ThumbAsset[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const asset of assets) {
    if (asset.targetType !== "character" || !asset.targetId) continue;
    if (map.has(asset.targetId)) continue;
    const src = asset.thumbnailUrl || asset.url;
    if (src) map.set(asset.targetId, src);
  }
  return map;
}
