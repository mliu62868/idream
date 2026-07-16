import type { Prisma, PrismaClient } from "@prisma/client";
import {
  evaluateCreativeMediaAuthority,
  parseCreativeMediaAuthorityEvidence,
} from "@/server/lib/creative-media-authority";
import { nonSyntheticMediaAssetWhere } from "@/server/lib/media-asset-authority";
import { operationalMediaAssetPlacementWhere } from "@/server/modules/admin/shared/metric-data-scope";

type Db = PrismaClient | Prisma.TransactionClient;
type CampaignPlacement = Prisma.MediaAssetPlacementGetPayload<{
  include: {
    mediaAsset: {
      include: {
        sourceJob: {
          select: { provider: true };
        };
      };
    };
  };
}>;

// Shared by the customer-facing Community renderer and Admin verification.
// This is the runtime serving predicate, not an Admin projection query.
export async function resolveCommunityCampaignPlacements(db: Db, limit = 6) {
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  if (normalizedLimit === 0) return [];
  const batchSize = Math.max(25, Math.min(normalizedLimit, 100));
  const accepted: CampaignPlacement[] = [];
  let cursor: string | undefined;
  while (accepted.length < normalizedLimit) {
    const candidates = await db.mediaAssetPlacement.findMany({
      where: operationalMediaAssetPlacementWhere({
        slot: "campaign",
        status: "published",
        verificationState: "passed",
        mediaAsset: {
          ...nonSyntheticMediaAssetWhere,
          deletedAt: null,
          safetyStatus: "passed",
          type: "image",
          visibility: { in: ["public_pack", "unlisted"] },
        },
      }),
      include: {
        mediaAsset: {
          include: {
            sourceJob: { select: { provider: true } },
          },
        },
      },
      orderBy: [
        { publishedAt: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (candidates.length === 0) break;
    const sourceJobIds = [
      ...new Set(
        candidates.flatMap((placement) =>
          placement.mediaAsset.sourceJobId
            ? [placement.mediaAsset.sourceJobId]
            : []
        ),
      ),
    ];
    const attempts = sourceJobIds.length > 0
      ? await db.generationAttempt.findMany({
          where: { requestId: { in: sourceJobIds } },
          orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
          select: { requestId: true, provider: true },
        })
      : [];
    const latestAttemptProvider = new Map<string, string | null>();
    for (const attempt of attempts) {
      if (!latestAttemptProvider.has(attempt.requestId)) {
        latestAttemptProvider.set(attempt.requestId, attempt.provider);
      }
    }
    for (const placement of candidates) {
      const evidence = parseCreativeMediaAuthorityEvidence(placement.metadata);
      if (evidence.kind === "invalid") continue;
      const sourceJobId = placement.mediaAsset.sourceJobId;
      const authority = evaluateCreativeMediaAuthority({
        metadata: placement.mediaAsset.metadata,
        current: {
          sourceJobId,
          jobProvider: placement.mediaAsset.sourceJob?.provider ?? null,
          latestAttemptProvider: sourceJobId
            ? latestAttemptProvider.get(sourceJobId) ?? null
            : null,
        },
        pinned: evidence.kind === "present"
          ? evidence.snapshot
          : undefined,
      });
      if (authority.publishable) accepted.push(placement);
      if (accepted.length === normalizedLimit) break;
    }
    cursor = candidates.at(-1)?.id;
    if (!cursor || candidates.length < batchSize) break;
  }
  return accepted;
}
