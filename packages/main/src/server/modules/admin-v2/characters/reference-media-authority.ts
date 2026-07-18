import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";

export const characterReferenceMediaAuthoritySelect = {
  id: true,
  type: true,
  characterId: true,
  deletedAt: true,
  safetyStatus: true,
  storageKey: true,
  url: true,
  metadata: true,
} as const;

export interface CharacterReferenceMediaAuthority {
  readonly id: string;
  readonly type: string;
  readonly characterId: string | null;
  readonly deletedAt: Date | null;
  readonly safetyStatus: string;
  readonly storageKey: string | null;
  readonly url: string | null;
  readonly metadata: unknown;
}

/**
 * A Reference Set is usable only while every referenced media row remains an
 * owned, available image for the same Character. Snapshot hashes intentionally
 * cover the immutable selection, so mutable media availability is a separate
 * authority predicate that every consumer must re-evaluate.
 */
export function isCharacterReferenceMediaAvailable(
  mediaAsset: CharacterReferenceMediaAuthority,
  characterId: string,
) {
  return mediaAsset.type === "image" &&
    mediaAsset.deletedAt === null &&
    mediaAsset.safetyStatus === "passed" &&
    isMediaAssetOperationalForAuthority(mediaAsset.metadata) &&
    hasHydratableMediaBlobAuthority(mediaAsset) &&
    mediaAsset.characterId === characterId;
}

export function unavailableCharacterReferenceMediaIds(
  references: readonly {
    readonly mediaAsset: CharacterReferenceMediaAuthority;
  }[],
  characterId: string,
) {
  return references.flatMap((reference) =>
    isCharacterReferenceMediaAvailable(reference.mediaAsset, characterId)
      ? []
      : [reference.mediaAsset.id]
  );
}
