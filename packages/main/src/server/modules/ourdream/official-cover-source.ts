import { Prisma, type MediaAsset, type PrismaClient } from "@prisma/client";
import { officialCharacterSeeds } from "@/lib/official-cold-start-content";
import { readBundledEditorialImage, persistBundledEditorialImage } from "@/server/lib/bundled-editorial-image";
import { Errors } from "@/server/lib/errors";
import { hasHydratableMediaBlobAuthority, isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import type { BlobStore } from "@/server/providers/types";

type OfficialCover = Pick<(typeof officialCharacterSeeds)[number], "id" | "image">;

function isOriginalOfficialCover(asset: MediaAsset, card: OfficialCover) {
  const metadata = asset.metadata && typeof asset.metadata === "object" && !Array.isArray(asset.metadata)
    ? asset.metadata : {};
  return asset.id === `seed-image-${card.id}` && asset.ownerId === "seed-system-creator" &&
    asset.characterId === card.id && asset.url === card.image && asset.type === "image" &&
    asset.visibility === "public_pack" && asset.safetyStatus === "passed" && !asset.deletedAt &&
    metadata.seedSource === "src/lib/official-cold-start-content.ts" &&
    metadata.ownership === "platform_official" && isMediaAssetOperationalForAuthority(metadata);
}

/** Only attach physical bytes to the original official import; never replace an operator's source or publication. */
export async function materializeOfficialCoverSource(input: {
  db: Pick<PrismaClient, "mediaAsset">;
  blob: Pick<BlobStore, "putPrivate">;
  characterId: string;
  dryRun?: boolean;
}) {
  const card = officialCharacterSeeds.find(row => row.id === input.characterId);
  if (!card) throw Errors.badRequest("Character is not in the official cover manifest");
  const asset = await input.db.mediaAsset.findUnique({ where: { id: `seed-image-${card.id}` } });
  if (!asset) return { characterId: card.id, state: "skipped" as const, reason: "missing_asset" };
  if (!isOriginalOfficialCover(asset, card)) return { characterId: card.id, assetId: asset.id, state: "skipped" as const, reason: "source_changed_or_unavailable" };
  if (hasHydratableMediaBlobAuthority(asset)) return { characterId: card.id, assetId: asset.id, state: "unchanged" as const, reason: "existing_locator" };
  const bundled = await readBundledEditorialImage(card.image);
  if (!bundled) throw Errors.conflict("The original bundled official cover is missing or unreadable", { assetId: asset.id });
  const evidence = { characterId: card.id, assetId: asset.id, contentSha256: bundled.contentSha256, contentType: bundled.contentType, sizeBytes: bundled.bytes.byteLength };
  if (input.dryRun) return { ...evidence, state: "planned" as const };
  const stored = await persistBundledEditorialImage(asset.id, bundled, input.blob);
  // Compare the complete read authority, including operational metadata. A
  // concurrent archive, ownership transfer or source edit must win over repair.
  const updated = await input.db.mediaAsset.updateMany({
    where: {
      id: asset.id, ownerId: asset.ownerId, characterId: asset.characterId,
      type: asset.type, url: asset.url, storageKey: asset.storageKey,
      visibility: asset.visibility, safetyStatus: asset.safetyStatus, deletedAt: null,
      contentType: asset.contentType, metadata: { equals: asset.metadata as Prisma.InputJsonValue },
    },
    data: stored,
  });
  if (updated.count !== 1) throw Errors.conflict("The official cover changed while its source bytes were being prepared", { assetId: asset.id });
  return { ...evidence, ...stored, state: "materialized" as const };
}
