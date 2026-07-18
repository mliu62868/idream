import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { publicCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";
import type { PublicCharacterPageMetadata } from "@/lib/character-page-metadata";

type PublicCharacterMetadataRow = {
  name: string;
  description: string;
  imageAsset: {
    url: string;
    thumbnailUrl: string | null;
  } | null;
};

export async function loadPublicCharacterPageMetadata(
  id: string,
): Promise<PublicCharacterPageMetadata | null> {
  return resolvePublicCharacterPageMetadata(id, () =>
    prisma.character.findFirst({
      where: {
        AND: [publicCharacterAudienceWhere, { id }],
      },
      select: {
        name: true,
        description: true,
        imageAsset: {
          select: {
            url: true,
            thumbnailUrl: true,
          },
        },
      },
    }),
  );
}

export async function resolvePublicCharacterPageMetadata(
  id: string,
  read: () => Promise<PublicCharacterMetadataRow | null>,
): Promise<PublicCharacterPageMetadata | null> {
  try {
    const character = await read();
    if (!character?.imageAsset) return null;

    return {
      name: character.name,
      description: character.description,
      imageUrl: character.imageAsset.thumbnailUrl ?? character.imageAsset.url,
    };
  } catch (error) {
    logger.error(
      {
        characterId: id,
        errorKind: error instanceof Error ? error.name : typeof error,
      },
      "Public character metadata authority is unavailable",
    );
    return null;
  }
}
