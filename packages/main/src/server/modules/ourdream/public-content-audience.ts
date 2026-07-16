import type { Prisma } from "@prisma/client";
import {
  nonSyntheticMediaAssetWhere,
  syntheticMediaAssetWhere,
} from "@/server/lib/media-asset-authority";

export {
  nonSyntheticMediaAssetWhere,
  syntheticMediaAssetWhere,
} from "@/server/lib/media-asset-authority";

export const activeCustomerUserWhere = {
  dataClass: "customer",
  status: "active",
  deletedAt: null,
} as const satisfies Prisma.UserWhereInput;

export const rawPublicCharacterWhere = {
  visibility: "public",
  status: "approved",
  deletedAt: null,
} as const satisfies Prisma.CharacterWhereInput;

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
      OR: [
        { imageAssetId: null },
        { imageAsset: { is: nonSyntheticMediaAssetWhere } },
      ],
    },
  ],
} as const satisfies Prisma.CharacterWhereInput;

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
        none: {
          mediaAsset: syntheticMediaAssetWhere,
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
    { sourceKey: { not: null } },
    {
      sourceKey: null,
      createdBy: { is: activeCustomerUserWhere },
    },
  ],
} as const satisfies Prisma.ProductFeedbackItemWhereInput;
