import type { Prisma, PrismaClient } from "@prisma/client";
import { operationalMediaAssetPlacementWhere } from "@/server/modules/admin/shared/metric-data-scope";

type Db = PrismaClient | Prisma.TransactionClient;

// Shared by the customer-facing Community renderer and Admin verification.
// This is the runtime serving predicate, not an Admin projection query.
export function resolveCommunityCampaignPlacements(db: Db, limit = 6) {
  return db.mediaAssetPlacement.findMany({
    where: operationalMediaAssetPlacementWhere({
      slot: "campaign",
      status: "published",
      verificationState: "passed",
      mediaAsset: {
        deletedAt: null,
        safetyStatus: "passed",
        type: "image",
        visibility: { in: ["public_pack", "unlisted"] },
      },
    }),
    include: { mediaAsset: true },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
}
