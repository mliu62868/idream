import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { verifyCharacterPreviewToken } from "./preview-token";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { draftAssetRouteEntries } from "./draft-asset-route-authority";
import { characterReleaseExactAssetPackByPurpose } from "./character-release-contract";

const previewPurposes = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

type PreviewPurpose = (typeof previewPurposes)[number];
type PreviewAssetPack = Record<PreviewPurpose, string>;

function record(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function draftAssetPack(value: Prisma.JsonValue): Partial<PreviewAssetPack> {
  const entries = draftAssetRouteEntries(value);
  return Object.fromEntries(previewPurposes.flatMap((purpose) => {
    const assetId = entries[purpose]?.assetId;
    return assetId ? [[purpose, assetId]] : [];
  }));
}

function exactPackMatches(
  expected: PreviewAssetPack,
  actual: Partial<PreviewAssetPack>,
) {
  return previewPurposes.every((purpose) => actual[purpose] === expected[purpose]);
}

export async function loadCharacterRendererPreview(token: string) {
  const authority = verifyCharacterPreviewToken(token, env.BETTER_AUTH_SECRET);
  if (!authority) return null;
  const assetIds = [...new Set(Object.values(authority.assetPack))];
  const [character, content, release, project, serving, imageAssets] = await Promise.all([
    prisma.character.findUnique({
      where: { id: authority.characterId },
      include: {
        creator: { select: { displayName: true, name: true } },
        stats: true,
        tags: { include: { tag: true } },
      },
    }),
    prisma.characterContentVersion.findUnique({ where: { id: authority.contentVersionId } }),
    authority.releaseId
      ? prisma.characterRelease.findUnique({ where: { id: authority.releaseId } })
      : Promise.resolve(null),
    prisma.characterProject.findFirst({
      where: { characterId: authority.characterId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, draftAssetPack: true },
    }),
    prisma.characterServing.findUnique({
      where: { characterId: authority.characterId },
      select: { state: true, currentReleaseId: true, version: true },
    }),
    prisma.mediaAsset.findMany({ where: { id: { in: assetIds } } }),
  ]);
  if (!character || !content || content.characterId !== character.id) return null;
  if (authority.releaseId && (!release || release.characterContentVersionId !== content.id)) return null;
  if (authority.label === "Live") {
    if (
      !release ||
      !project ||
      serving?.state !== "live" ||
      serving.currentReleaseId !== release.id ||
      serving.version !== authority.servingVersion ||
      release.projectId !== project.id ||
      !exactPackMatches(authority.assetPack, characterReleaseExactAssetPackByPurpose(release))
    ) return null;
  } else {
    if (
      !project ||
      (release && release.projectId !== project.id) ||
      !exactPackMatches(authority.assetPack, draftAssetPack(project.draftAssetPack))
    ) return null;
  }
  const imageAssetById = new Map(imageAssets.map((asset) => [asset.id, asset]));
  if (previewPurposes.some((purpose) => {
    const asset = imageAssetById.get(authority.assetPack[purpose]);
    return !asset ||
      asset.deletedAt !== null ||
      asset.type !== "image" ||
      asset.safetyStatus !== "passed" ||
      asset.characterId !== character.id ||
      !isMediaAssetOperationalForAuthority(asset.metadata);
  })) return null;

  const persona = record(content.personaSnapshot);
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  const exactAssets = Object.fromEntries(previewPurposes.map((purpose) => {
    const assetId = authority.assetPack[purpose];
    const asset = imageAssetById.get(assetId)!;
    return [purpose, {
      assetId,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
    }];
  })) as Record<PreviewPurpose, {
    assetId: string;
    url: string;
    thumbnailUrl: string | null;
  }>;
  const creator = character.creator?.displayName ?? character.creator?.name ??
    (character.source === "official" ? "@ourdream" : "Creator");
  return {
    authority,
    assetPack: exactAssets,
    character: {
      id: character.id,
      title: text(persona.name) || character.name,
      age: String(character.age),
      description: text(persona.description) || character.description,
      likes: String(character.stats?.likesCount ?? 0),
      chats: String(character.stats?.chatsCount ?? 0),
      creator,
      image: exactAssets.character_cover.url,
      imageAssetId: exactAssets.character_cover.assetId,
      heroImage: exactAssets.character_hero.url,
      heroImageAssetId: exactAssets.character_hero.assetId,
      vivid: character.vivid,
      style: character.style,
      gender: character.gender,
      tags: character.tags.map(({ tag }) => ({ label: tag.label, slug: tag.slug })),
    },
    openingMessage: text(opening.firstMessage) || "Opening message unavailable",
    exampleDialogue: stringList(persona.exampleDialogue),
    appearance,
  };
}
