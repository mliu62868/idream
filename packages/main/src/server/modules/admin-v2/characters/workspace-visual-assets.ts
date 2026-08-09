import type { Prisma } from "@prisma/client";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";

type VisualAssetProjectionSource = {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  deletedAt: Date | null;
  type: string;
  safetyStatus: string;
  characterId: string | null;
  metadata: Prisma.JsonValue;
};

export function visualAssetAvailable(asset: VisualAssetProjectionSource, expectedCharacterId: string) {
  return asset.deletedAt === null &&
    asset.type === "image" &&
    asset.safetyStatus === "passed" &&
    isMediaAssetOperationalForAuthority(asset.metadata) &&
    asset.characterId === expectedCharacterId;
}

export function visualAssetDto(asset: VisualAssetProjectionSource, role: string, expectedCharacterId: string, scores: { qualityScore?: number | null; identityScore?: number | null } = {}) {
  const available = visualAssetAvailable(asset, expectedCharacterId);
  return {
    mediaAssetId: asset.id,
    role,
    available,
    url: available ? asset.url : null,
    thumbnailUrl: available ? asset.thumbnailUrl : null,
    qualityScore: scores.qualityScore ?? null,
    identityScore: scores.identityScore ?? null,
  };
}

export function videoSourceAssetDto(
  asset: VisualAssetProjectionSource,
  expectedCharacterId: string,
) {
  const available = visualAssetAvailable(asset, expectedCharacterId);
  return {
    mediaAssetId: asset.id,
    available,
    url: available ? asset.url : null,
    thumbnailUrl: available ? asset.thumbnailUrl : null,
  };
}

export function visualPoolDtos(
  assetIds: readonly string[],
  role: "identity_anchor" | "identity_reference",
  assets: ReadonlyMap<string, VisualAssetProjectionSource>,
  expectedCharacterId: string,
) {
  return assetIds.map((mediaAssetId) => {
    const asset = assets.get(mediaAssetId);
    return asset ? visualAssetDto(asset, role, expectedCharacterId) : {
      mediaAssetId,
      role,
      available: false,
      url: null,
      thumbnailUrl: null,
      qualityScore: null,
      identityScore: null,
    };
  });
}
