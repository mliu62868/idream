import type { Prisma } from "@prisma/client";
import { nonSyntheticMediaAssetWhere } from "@/server/modules/ourdream/public-content-audience";

const REUSABLE_CHAT_PURPOSE = "character_chat";
const REUSABLE_STATUSES = ["approved", "published"] as const;

// Historical delivered platform assets remain readable and eligible as edit sources.
export function isReusablePlatformAssetWhere(userId: string): Prisma.MediaAssetWhereInput {
  return {
    OR: [
      { ownerId: userId },
      {
        ...nonSyntheticMediaAssetWhere,
        productionItems: {
          some: {
            status: { in: [...REUSABLE_STATUSES] },
            batch: { purpose: REUSABLE_CHAT_PURPOSE },
          },
        },
      },
    ],
  };
}
