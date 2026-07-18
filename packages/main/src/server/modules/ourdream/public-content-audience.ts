import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  characterReleaseAssetPlacement,
  parseCharacterReleaseAssetManifest,
} from "@idream/shared/admin";
import {
  evaluateMediaAssetCustomerPublishability,
  hasHydratableMediaBlobAuthority,
  nonSyntheticMediaAssetWhere,
} from "@/server/lib/media-asset-authority";
import {
  MODERN_CHARACTER_RELEASE_POLICY_VERSION,
  PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
} from "./public-catalog-qualification";

export {
  nonSyntheticMediaAssetWhere,
  syntheticMediaAssetWhere,
} from "@/server/lib/media-asset-authority";

export const activeCustomerUserWhere = {
  dataClass: "customer",
  role: "user",
  status: "active",
  deletedAt: null,
} as const satisfies Prisma.UserWhereInput;

export const rawPublicCharacterWhere = {
  visibility: "public",
  status: "approved",
  deletedAt: null,
} as const satisfies Prisma.CharacterWhereInput;

export const publicReadableMediaAssetWhere = {
  AND: [
    nonSyntheticMediaAssetWhere,
    {
      deletedAt: null,
      visibility: "public_pack",
      safetyStatus: "passed",
    },
    {
      OR: [
        {
          metadata: {
            path: ["platformAsset", "status"],
            equals: Prisma.AnyNull,
          },
        },
        {
          AND: [
            {
              NOT: {
                metadata: {
                  path: ["platformAsset", "status"],
                  equals: "archived",
                },
              },
            },
            {
              NOT: {
                metadata: {
                  path: ["platformAsset", "status"],
                  equals: "rejected",
                },
              },
            },
            {
              NOT: {
                metadata: {
                  path: ["platformAsset", "status"],
                  equals: "blocked",
                },
              },
            },
          ],
        },
      ],
    },
  ],
} as const satisfies Prisma.MediaAssetWhereInput;

const publicCurrentReleaseWhere = {
  status: "published",
  publishedAt: { not: null },
  OR: [
    {
      legacy: true,
      readiness: "ready",
      generationProvenance: {
        path: ["schemaVersion"],
        equals: "character-release-editorial-import-v1",
      },
      publicCatalogQualification: {
        is: {
          kind: "editorial_import",
          validationRunId: null,
          revokedAt: null,
          evidence: {
            path: ["policyVersion"],
            equals: PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
          },
        },
      },
    },
    {
      legacy: false,
      readiness: "ready",
      AND: [
        {
          generationProvenance: {
            path: ["schemaVersion"],
            equals: "character-release-generation-provenance-v2",
          },
        },
        {
          generationProvenance: {
            path: ["policyVersion"],
            equals: MODERN_CHARACTER_RELEASE_POLICY_VERSION,
          },
        },
        {
          releasePlacementManifest: {
            path: ["schemaVersion"],
            equals: 2,
          },
        },
      ],
      publicCatalogQualification: {
        is: {
          kind: "generated_release",
          validationRunId: { not: null },
          revokedAt: null,
          validationRun: {
            is: {
              policyVersion: MODERN_CHARACTER_RELEASE_POLICY_VERSION,
              result: "passed",
              finishedAt: { not: null },
            },
          },
        },
      },
    },
  ],
} as const satisfies Prisma.CharacterReleaseWhereInput;

export const publicCharacterAudienceWhere = {
  AND: [
    rawPublicCharacterWhere,
    {
      OR: [
        { source: "official" },
        {
          source: "user",
          creator: { is: activeCustomerUserWhere },
        },
      ],
    },
    {
      imageAsset: {
        is: {
          AND: [
            publicReadableMediaAssetWhere,
            { type: "image" },
          ],
        },
      },
    },
    {
      serving: {
        is: {
          state: "live",
          currentRelease: {
            is: publicCurrentReleaseWhere,
          },
        },
      },
    },
  ],
} as const satisfies Prisma.CharacterWhereInput;

type PublicAssetPackDb = PrismaClient | Prisma.TransactionClient;

export async function resolvePublicCharacterReleaseAssetPack(
  db: PublicAssetPackDb,
  input: {
    readonly characterId: string;
    readonly imageAssetId: string | null;
    readonly releasePlacementManifest: unknown;
  },
) {
  const manifest = parseCharacterReleaseAssetManifest(
    input.releasePlacementManifest,
  );
  if (!manifest) return null;
  const avatarPlacement = characterReleaseAssetPlacement(
    manifest,
    "character_avatar",
  );
  const heroPlacement = characterReleaseAssetPlacement(
    manifest,
    "character_hero",
  );
  const chatPlacement = characterReleaseAssetPlacement(
    manifest,
    "character_chat",
  );
  if (
    !avatarPlacement ||
    !heroPlacement ||
    !chatPlacement ||
    avatarPlacement.assetId !== input.imageAssetId
  ) {
    return null;
  }

  const assetIds = [
    avatarPlacement.assetId,
    heroPlacement.assetId,
    chatPlacement.assetId,
  ];
  const assets = await db.mediaAsset.findMany({
    where: {
      AND: [
        publicReadableMediaAssetWhere,
        {
          id: { in: assetIds },
          characterId: input.characterId,
          type: "image",
        },
      ],
    },
  });
  if (assets.length !== 3) return null;
  const byId = new Map(assets.map((asset) => [asset.id, asset] as const));
  const avatar = byId.get(avatarPlacement.assetId);
  const hero = byId.get(heroPlacement.assetId);
  const chat = byId.get(chatPlacement.assetId);
  if (!avatar || !hero || !chat) return null;
  if (
    ![avatar, hero, chat].every((asset) =>
      hasHydratableMediaBlobAuthority(asset) &&
      evaluateMediaAssetCustomerPublishability({
        metadata: asset.metadata,
      }).publishable
    )
  ) {
    return null;
  }
  return { avatar, hero, chat } as const;
}

export const rawPublicCollectionWhere = {
  visibility: "public",
} as const satisfies Prisma.MediaCollectionWhereInput;

export const publicCollectionAudienceWhere = {
  AND: [
    rawPublicCollectionWhere,
    {
      OR: [
        { source: "official" },
        {
          source: "user",
          owner: { is: activeCustomerUserWhere },
        },
      ],
    },
    {
      items: {
        some: {},
        none: {
          mediaAsset: {
            isNot: publicReadableMediaAssetWhere,
          },
        },
      },
    },
  ],
} as const satisfies Prisma.MediaCollectionWhereInput;

export const rawPublicFeedbackWhere = {
  visibility: "public",
} as const satisfies Prisma.ProductFeedbackItemWhereInput;

export const publicFeedbackAudienceWhere = {
  ...rawPublicFeedbackWhere,
  OR: [
    { source: "official" },
    {
      source: "user",
      createdBy: {
        is: activeCustomerUserWhere,
      },
    },
  ],
} as const satisfies Prisma.ProductFeedbackItemWhereInput;
