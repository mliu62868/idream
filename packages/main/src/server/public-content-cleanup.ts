import type { PrismaClient } from "@prisma/client";
import {
  publicCharacterAudienceWhere,
  publicCollectionAudienceWhere,
  rawPublicCharacterWhere,
  rawPublicCollectionWhere,
} from "@/server/modules/ourdream/public-content-audience";

type CleanupDb = PrismaClient;

export type PublicContentCleanupPlan = {
  generatedAt: string;
  characters: Array<{
    id: string;
    ownerDataClass: string | null;
    toVisibility: "unlisted";
  }>;
  collections: Array<{
    id: string;
    ownerDataClass: string;
    toVisibility: "unlisted";
  }>;
};

export async function planPublicContentCleanup(
  db: CleanupDb,
): Promise<PublicContentCleanupPlan> {
  const [rawCharacters, audienceCharacters, rawCollections, audienceCollections] =
    await Promise.all([
      db.character.findMany({
        where: rawPublicCharacterWhere,
        select: {
          id: true,
          creator: { select: { dataClass: true } },
        },
      }),
      db.character.findMany({
        where: publicCharacterAudienceWhere,
        select: { id: true },
      }),
      db.mediaCollection.findMany({
        where: rawPublicCollectionWhere,
        select: {
          id: true,
          owner: { select: { dataClass: true } },
        },
      }),
      db.mediaCollection.findMany({
        where: publicCollectionAudienceWhere,
        select: { id: true },
      }),
    ]);
  const audienceCharacterIds = new Set(audienceCharacters.map((row) => row.id));
  const audienceCollectionIds = new Set(audienceCollections.map((row) => row.id));

  return {
    generatedAt: new Date().toISOString(),
    characters: rawCharacters
      .filter((row) => !audienceCharacterIds.has(row.id))
      .map((row) => ({
        id: row.id,
        ownerDataClass: row.creator?.dataClass ?? null,
        toVisibility: "unlisted" as const,
      })),
    collections: rawCollections
      .filter((row) => !audienceCollectionIds.has(row.id))
      .map((row) => ({
        id: row.id,
        ownerDataClass: row.owner.dataClass,
        toVisibility: "unlisted" as const,
      })),
  };
}

export async function applyPublicContentCleanup(
  db: CleanupDb,
  plan: PublicContentCleanupPlan,
) {
  const characterIds = plan.characters.map((row) => row.id);
  const collectionIds = plan.collections.map((row) => row.id);
  const [characters, collections] = await db.$transaction([
    db.character.updateMany({
      where: {
        id: { in: characterIds },
        source: "user",
        visibility: "public",
      },
      data: { visibility: "unlisted" },
    }),
    db.mediaCollection.updateMany({
      where: {
        id: { in: collectionIds },
        source: "user",
        visibility: "public",
      },
      data: { visibility: "unlisted" },
    }),
  ]);

  return {
    charactersUpdated: characters.count,
    collectionsUpdated: collections.count,
  };
}
