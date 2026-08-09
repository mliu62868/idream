import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  characterReleaseAssetPlacement,
  parseCharacterReleaseAssetManifest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
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

// SPEC: 这个 userId 的点赞/浏览算不算真实客户互动。
// INTENT: 与 activeCustomerUserWhere 同住 —— 「谁算客户」在整个公开面上只能有一个答案。
// 它此前住在 service.ts 里，于是那条 where 有两个副本式的用法：一处过滤 row、
// 一处判定 actor，改一边漏一边就会让内部账号的点赞被计入公开榜单。
export async function isCustomerEngagementActor(userId: string) {
  const actor = await prisma.user.findFirst({
    where: {
      id: userId,
      ...activeCustomerUserWhere,
    },
    select: { id: true },
  });
  return Boolean(actor);
}

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

// SPEC: 「谁能看到这个角色」的唯一答案。
// INVARIANT: age >= 18 属于这个答案本身，不是调用方的附加条款。此前它不在谓词里，于是每个读路径
// 都得自己记得 AND 一次 —— 记得的只有一处，其余全靠 rawPublicCharacterWhere 的 status/visibility
// 间接兜底。这条只许收紧、不许放宽。
export const publicCharacterAudienceWhere = {
  AND: [
    rawPublicCharacterWhere,
    { age: { gte: 18 } },
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
