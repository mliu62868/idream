import type { Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { jsonRecord as record, jsonText as text } from "../shared/prisma-json";
import { characterReleaseExactAssetPackByPurpose } from "./character-release-contract";
import { issueCharacterPreviewToken } from "./preview-token";

const characterPreviewAssetPurposes = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

type CharacterPreviewAssetPurpose = (typeof characterPreviewAssetPurposes)[number];

type CharacterPreviewAssetPackIds = Partial<Record<CharacterPreviewAssetPurpose, string>>;

export function releasePreviewAssetPackIds(
  release: { releasePlacementManifest: Prisma.JsonValue } | null,
): CharacterPreviewAssetPackIds {
  return release ? characterReleaseExactAssetPackByPurpose(release) : {};
}

type CharacterPreviewMediaAsset = {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  deletedAt: Date | null;
  type: string;
  safetyStatus: string;
  characterId: string | null;
  metadata: Prisma.JsonValue;
};

export function previewAssetPackDto(
  assetIds: CharacterPreviewAssetPackIds,
  assets: ReadonlyMap<string, CharacterPreviewMediaAsset>,
  characterId: string,
) {
  return Object.fromEntries(characterPreviewAssetPurposes.map((purpose) => {
    const assetId = assetIds[purpose] ?? null;
    const asset = assetId ? assets.get(assetId) : null;
    const available = Boolean(
      asset &&
      asset.deletedAt === null &&
      asset.type === "image" &&
      asset.safetyStatus === "passed" &&
      asset.characterId === characterId &&
      isMediaAssetOperationalForAuthority(asset.metadata)
    );
    return [purpose, {
      assetId,
      imageUrl: available && asset
        ? asset.thumbnailUrl ?? asset.url
        : null,
      status: assetId === null
        ? "missing" as const
        : available
          ? "available" as const
          : "unavailable" as const,
    }];
  })) as Record<CharacterPreviewAssetPurpose, {
    assetId: string | null;
    imageUrl: string | null;
    status: "available" | "missing" | "unavailable";
  }>;
}

export function previewSnapshot(input: {
  character: { id: string; name: string; description: string; appearance: Prisma.JsonValue; advancedDetails: Prisma.JsonValue };
  content: {
    id: string;
    personaSnapshot: Prisma.JsonValue;
    openingSnapshot: Prisma.JsonValue;
    appearanceSnapshot: Prisma.JsonValue;
  } | null;
  releaseId: string | null;
  servingVersion: number | null;
  assetPack: ReturnType<typeof previewAssetPackDto>;
  label: "Live" | "Draft Preview";
}) {
  const persona = input.content ? record(input.content.personaSnapshot) : record(input.character.advancedDetails);
  const opening = input.content ? record(input.content.openingSnapshot) : {
    firstMessage: record(input.character.advancedDetails).firstMessage ?? null,
  };
  const appearance = input.content ? record(input.content.appearanceSnapshot) : record(input.character.appearance);
  const selectedAssetIds = characterPreviewAssetPurposes.flatMap((purpose) =>
    input.assetPack[purpose].assetId ? [input.assetPack[purpose].assetId] : []
  );
  const assetPackReady = characterPreviewAssetPurposes.every(
    (purpose) => input.assetPack[purpose].status === "available",
  ) && new Set(selectedAssetIds).size === characterPreviewAssetPurposes.length;
  const exactAssetPack = assetPackReady ? {
    character_cover: input.assetPack.character_cover.assetId!,
    character_hero: input.assetPack.character_hero.assetId!,
    character_chat: input.assetPack.character_chat.assetId!,
  } : null;
  const renderUrl = input.content && exactAssetPack
    ? new URL(
        `/internal-preview/characters/${encodeURIComponent(issueCharacterPreviewToken({
          characterId: input.character.id,
          contentVersionId: input.content.id,
          releaseId: input.releaseId,
          servingVersion: input.servingVersion,
          imageAssetId: exactAssetPack.character_cover,
          assetPack: exactAssetPack,
          label: input.label,
        }, env.BETTER_AUTH_SECRET))}`,
        env.BETTER_AUTH_URL,
      ).toString()
    : null;
  return {
    releaseId: input.releaseId,
    contentVersionId: input.content?.id ?? null,
    label: input.label,
    name: text(persona.name) || input.character.name,
    description: text(persona.description) || input.character.description,
    persona,
    opening,
    appearance,
    imageUrl: input.assetPack.character_cover.imageUrl,
    assetPack: input.assetPack,
    assetPackReady,
    renderUrl,
  };
}

export function previewChangedFields(
  live: ReturnType<typeof previewSnapshot> | null,
  draft: ReturnType<typeof previewSnapshot>,
) {
  if (!live) return ["new_release"];
  return (["name", "description", "persona", "opening", "appearance", "imageUrl", "assetPack"] as const)
    .filter((key) => JSON.stringify(live[key]) !== JSON.stringify(draft[key]));
}
