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
  updatedAt: string;
  tags: string[];
  stats: OfficialStats;
  appearance: unknown;
  advancedDetails: unknown;
  imageAssetId: string | null;
  visualProfile: {
    id: string;
    version: number;
    status: string;
    style: string;
    qualityScore?: number | null;
    consistencyScore?: number | null;
    faceTraits?: unknown;
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
  creativeBrief: string;
  archetype: string;
  relationship: string;
  personality: string;
  speakingStyle: string;
  backstory: string;
  firstMessage: string;
  exampleDialogue: string;
  appearanceNotes: string;
  visualBrief: string;
  reason: string;
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function textField(value: unknown, key: string): string {
  const field = recordOf(value)[key];
  return typeof field === "string" ? field : "";
}

export function visualSourceImage(row: OfficialRow): string | null {
  const sourceImage = recordOf(row.visualProfile?.faceTraits).sourceImage;
  return typeof sourceImage === "string" && sourceImage.trim() ? sourceImage : null;
}

export function officialPayload(draft: OfficialDraft): Record<string, unknown> {
  const parsedAge = Number.parseInt(draft.age.trim(), 10);
  return {
    name: draft.name.trim(),
    age: Number.isFinite(parsedAge) ? parsedAge : 18,
    gender: draft.gender,
    style: draft.style,
    description: draft.description.trim(),
    tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    appearance: {
      notes: draft.appearanceNotes.trim(),
      visualBrief: draft.visualBrief.trim(),
    },
    advancedDetails: {
      creativeBrief: draft.creativeBrief.trim(),
      archetype: draft.archetype.trim(),
      relationship: draft.relationship.trim(),
      personality: draft.personality.trim(),
      speakingStyle: draft.speakingStyle.trim(),
      backstory: draft.backstory.trim(),
      firstMessage: draft.firstMessage.trim(),
      exampleDialogue: draft.exampleDialogue.trim(),
      visualBrief: draft.visualBrief.trim(),
    },
    reason: draft.reason.trim(),
  };
}

export type CharacterReadiness = {
  score: number;
  completed: number;
  total: number;
  missing: string[];
};

export function characterReadiness(row: OfficialRow, hasPublishedArtwork: boolean): CharacterReadiness {
  const checks = [
    { label: "Core profile", ok: Boolean(row.name.trim() && row.description.trim() && row.tags.length > 0) },
    { label: "Persona", ok: Boolean(textField(row.advancedDetails, "personality") && textField(row.advancedDetails, "firstMessage")) },
    { label: "Visual direction", ok: Boolean(textField(row.appearance, "visualBrief") || textField(row.advancedDetails, "visualBrief")) },
    { label: "Visual identity", ok: Boolean(row.visualProfile) },
    { label: "Reference images", ok: visualReferenceCount(row) > 0 },
    { label: "Published artwork", ok: hasPublishedArtwork || Boolean(row.imageAssetId) },
  ];
  const completed = checks.filter((check) => check.ok).length;
  return {
    completed,
    total: checks.length,
    score: Math.round((completed / checks.length) * 100),
    missing: checks.filter((check) => !check.ok).map((check) => check.label),
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
