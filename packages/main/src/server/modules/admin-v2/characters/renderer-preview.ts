import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { verifyCharacterPreviewToken } from "./preview-token";

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

export async function loadCharacterRendererPreview(token: string) {
  const authority = verifyCharacterPreviewToken(token, env.BETTER_AUTH_SECRET);
  if (!authority) return null;
  const [character, content, release, imageAsset] = await Promise.all([
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
    authority.imageAssetId
      ? prisma.mediaAsset.findUnique({ where: { id: authority.imageAssetId } })
      : Promise.resolve(null),
  ]);
  if (!character || !content || content.characterId !== character.id) return null;
  if (authority.releaseId && (!release || release.characterContentVersionId !== content.id)) return null;
  if (authority.imageAssetId && (!imageAsset || imageAsset.deletedAt || imageAsset.safetyStatus !== "passed")) return null;
  if (release) {
    const manifest = record(release.releasePlacementManifest);
    const placements = Array.isArray(manifest.placements) ? manifest.placements : [];
    const avatar = placements.find((value) => {
      const placement = value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      return placement.slotKey === "character_avatar";
    });
    const avatarRecord = avatar !== null && typeof avatar === "object" && !Array.isArray(avatar)
      ? avatar as Record<string, unknown>
      : {};
    const manifestAssetId = typeof avatarRecord.assetId === "string" ? avatarRecord.assetId : null;
    if (manifestAssetId !== authority.imageAssetId) return null;
  } else if (authority.imageAssetId) {
    return null;
  }

  const persona = record(content.personaSnapshot);
  const opening = record(content.openingSnapshot);
  const appearance = record(content.appearanceSnapshot);
  const image = imageAsset?.url ?? "/images/ourdream/promo-card-female.webp";
  const creator = character.creator?.displayName ?? character.creator?.name ??
    (character.source === "official" ? "@ourdream" : "Creator");
  return {
    authority,
    character: {
      id: character.id,
      title: text(persona.name) || character.name,
      age: String(character.age),
      description: text(persona.description) || character.description,
      likes: String(character.stats?.likesCount ?? 0),
      chats: String(character.stats?.chatsCount ?? 0),
      creator,
      image,
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
