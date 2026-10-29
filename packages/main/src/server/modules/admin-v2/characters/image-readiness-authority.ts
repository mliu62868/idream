import { readBundledEditorialImage } from "@/server/lib/bundled-editorial-image";
import {
  hasHydratableMediaBlobAuthority,
} from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";

export type CharacterImageAssetAuthorityInput = {
  readonly id: string;
  readonly ownerId: string;
  readonly characterId: string | null;
  readonly type: string;
  readonly url: string;
  readonly thumbnailUrl: string | null;
  readonly storageKey: string | null;
  readonly contentType: string | null;
  readonly visibility: string;
  readonly safetyStatus: string;
  readonly deletedAt: Date | string | null;
  readonly metadata: unknown;
};

export type CharacterImageAssetAuthority = {
  readonly id: string;
  readonly ownerId: string;
  readonly characterId: string | null;
  readonly type: string;
  readonly url: string;
  readonly thumbnailUrl: string | null;
  readonly storageKey: string | null;
  readonly contentType: string | null;
  readonly visibility: string;
  readonly safetyStatus: string;
  readonly deletedAt: string | null;
  readonly metadata: unknown;
  readonly bundledContentSha256: string | null;
};

export type CharacterImageReadinessFingerprintInput = {
  readonly characterId: string;
  readonly characterImageAssetId: string | null;
  readonly sourceAsset: CharacterImageAssetAuthority | null;
  readonly projectId: string;
  readonly projectVersion: number;
  readonly draftImageAssetId: string | null;
  readonly draftAssetPack: unknown;
  readonly serving: {
    readonly currentReleaseId: string | null;
    readonly version: number;
  } | null;
  readonly currentRelease: {
    readonly id: string;
    readonly version: number;
    readonly snapshotHash: string;
  } | null;
  readonly activeIdentity: {
    readonly id: string;
    readonly version: number;
    readonly immutableHash: string | null;
  } | null;
  readonly activeReferenceSet: {
    readonly id: string;
    readonly revision: number;
    readonly snapshotHash: string | null;
  } | null;
};

export function characterImageAssetAuthority(
  asset: CharacterImageAssetAuthorityInput,
  bundledContentSha256: string | null,
): CharacterImageAssetAuthority {
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    characterId: asset.characterId,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl,
    storageKey: asset.storageKey,
    contentType: asset.contentType,
    visibility: asset.visibility,
    safetyStatus: asset.safetyStatus,
    deletedAt: asset.deletedAt instanceof Date
      ? asset.deletedAt.toISOString()
      : asset.deletedAt,
    metadata: asset.metadata,
    bundledContentSha256,
  };
}

export async function inspectCharacterImageGenerationSource(
  asset: CharacterImageAssetAuthorityInput,
) {
  if (hasHydratableMediaBlobAuthority(asset)) {
    return {
      authority: characterImageAssetAuthority(asset, null),
      materializable: true,
      bundled: null,
    } as const;
  }
  const bundled = await readBundledEditorialImage(asset.url);
  return {
    authority: characterImageAssetAuthority(
      asset,
      bundled?.contentSha256 ?? null,
    ),
    materializable: bundled !== null,
    bundled,
  } as const;
}

export function characterImageReadinessFingerprint(
  input: CharacterImageReadinessFingerprintInput,
) {
  return canonicalSha256(input);
}
