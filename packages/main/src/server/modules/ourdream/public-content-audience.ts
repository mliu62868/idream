import type { Prisma } from "@prisma/client";

const activeCustomerOwnerWhere = {
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
  ...rawPublicCharacterWhere,
  OR: [
    { source: "official" },
    {
      source: "user",
      creator: { is: activeCustomerOwnerWhere },
    },
  ],
} as const satisfies Prisma.CharacterWhereInput;

export const rawPublicCollectionWhere = {
  visibility: "public",
} as const satisfies Prisma.MediaCollectionWhereInput;

export const publicCollectionAudienceWhere = {
  ...rawPublicCollectionWhere,
  OR: [
    { source: "official" },
    {
      source: "user",
      owner: { is: activeCustomerOwnerWhere },
    },
  ],
} as const satisfies Prisma.MediaCollectionWhereInput;

export const publicFeedbackAudienceWhere = {
  OR: [
    { sourceKey: { not: null } },
    {
      sourceKey: null,
      createdBy: { is: activeCustomerOwnerWhere },
    },
  ],
} as const satisfies Prisma.ProductFeedbackItemWhereInput;
