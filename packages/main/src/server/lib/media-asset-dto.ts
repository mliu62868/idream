import type { Prisma } from "@prisma/client";
import { isSyntheticMediaAsset } from "./media-asset-authority";
import type { ResolvedMediaAssetAuthority } from "./media-asset-authority-query";

// SPEC: 运营侧一行 MediaAsset 的唯一 wire 形状。
// INTENT: Creative Run 候选、Image Library、Placement 三个视图都要回答「这张图能不能给
// 客户看」。它们分属 admin-v2 与 legacy admin 两层，所以这份 DTO 住在 lib，两层都能引，
// 不必各抄一份 —— 抄一份就等于让同一张素材在三个页面上答出不同的 customerPublishable。
// INVARIANT: 客户资产的 prompt 属于 support 明文，受 support.plaintext.view + consent/legal hold 约束；
// creative.asset.read 不能绕过它。只有运营自产（production item / metadata.platformAsset）才带 prompt。
export function mediaAssetDTO(asset: {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  safetyStatus: string;
  sourceJobId: string | null;
  prompt: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}, authority?: ResolvedMediaAssetAuthority, provenance: { readonly hasProductionItem?: boolean } = {}) {
  const isOperatorAuthored = provenance.hasProductionItem === true || hasPlatformAssetMetadata(asset.metadata);
  const isSynthetic = isSyntheticMediaAsset(asset.metadata);
  const publishabilityReasons = authority?.reasons ?? (
    isSynthetic ? ["metadata_synthetic"] : []
  );
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl ?? asset.url,
    contentType: asset.contentType,
    width: asset.width,
    height: asset.height,
    safetyStatus: asset.safetyStatus,
    sourceJobId: asset.sourceJobId,
    isSynthetic,
    customerPublishable: authority?.publishable ?? !isSynthetic,
    publishabilityReasons,
    promptSummary: isOperatorAuthored && asset.prompt ? asset.prompt.slice(0, 180) : null,
    metadata: isOperatorAuthored ? asset.metadata : stripPromptText(asset.metadata),
    createdAt: asset.createdAt,
  };
}

export function hasPlatformAssetMetadata(metadata: Prisma.JsonValue) {
  return metadata !== null
    && typeof metadata === "object"
    && !Array.isArray(metadata)
    && metadata.platformAsset !== null
    && typeof metadata.platformAsset === "object"
    && !Array.isArray(metadata.platformAsset);
}

// Generation writers put customer wording under these names; matched at any depth, since a
// `sourceGeneration`-style wrapper nests one record inside another.
const PROMPT_TEXT_KEY = /prompt|conversationContext/i;

function stripPromptText(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) return value.map(stripPromptText);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PROMPT_TEXT_KEY.test(key))
      .map(([key, child]) => [key, child === undefined ? null : stripPromptText(child)]),
  );
}
