import type { Prisma } from "@prisma/client";
import { isSyntheticMediaAsset } from "./media-asset-authority";
import type { ResolvedMediaAssetAuthority } from "./media-asset-authority-query";

// SPEC: 运营侧一行 MediaAsset 的唯一 wire 形状。
// INTENT: Creative Run 候选、Image Library、Placement 三个视图都要回答「这张图能不能给
// 客户看」。它们分属 admin-v2 与 legacy admin 两层，所以这份 DTO 住在 lib，两层都能引，
// 不必各抄一份 —— 抄一份就等于让同一张素材在三个页面上答出不同的 customerPublishable。
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
}, authority?: ResolvedMediaAssetAuthority) {
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
    promptSummary: asset.prompt ? asset.prompt.slice(0, 180) : null,
    metadata: asset.metadata,
    createdAt: asset.createdAt,
  };
}
