import type { Prisma, PrismaClient } from "@prisma/client";
import {
  evaluateCreativeMediaAuthority,
  parseCreativeMediaAuthorityEvidence,
} from "@/server/lib/creative-media-authority";
import { inspectOperatorUploadAuthority, mediaAssetPlatformStatus, nonSyntheticMediaAssetWhere } from "@/server/lib/media-asset-authority";
import { operationalMediaAssetPlacementWhere } from "@/server/modules/metric-data-scope";

type Db = PrismaClient | Prisma.TransactionClient;
export const UPLOADED_CAMPAIGN_AUTHORITY_SCHEMA = "uploaded-campaign-placement-v1";
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

export type CommunityCampaignAuthoredCopy = {
  readonly eyebrow: string;
  readonly title: string;
  readonly ctaLabel: string | null;
  readonly href: string | null;
};

function normalizedCopyString(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

function safeCampaignHref(value: string | null): string | null {
  if (!value) return null;
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return null;
  }
  if (value.startsWith("/")) {
    try {
      return new URL(value, "https://community.invalid").origin ===
        "https://community.invalid"
        ? value
        : null;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === ""
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parseCommunityCampaignAuthoredCopy(
  value: unknown,
): CommunityCampaignAuthoredCopy | null {
  const metadata = value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const eyebrow = normalizedCopyString(metadata.eyebrow, 80);
  const title = normalizedCopyString(metadata.title, 120);
  if (!eyebrow || !title) return null;

  const ctaLabel = normalizedCopyString(metadata.ctaLabel, 60);
  const rawHref = normalizedCopyString(metadata.href, 512);
  const href = safeCampaignHref(rawHref);
  if (
    (metadata.ctaLabel !== undefined && !ctaLabel) ||
    (metadata.href !== undefined && (!rawHref || !href))
  ) {
    return null;
  }
  if (Boolean(ctaLabel) !== Boolean(href)) return null;
  return { eyebrow, title, ctaLabel, href };
}

// Shared by the customer-facing Community renderer and Admin verification.
// This is the runtime serving predicate, not an Admin projection query.
export async function resolveCommunityCampaignPlacements(db: Db, limit = 6, mediaAssetId?: string) {
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  if (normalizedLimit === 0) return [];
  const batchSize = Math.max(25, Math.min(normalizedLimit, 100));
  const accepted: CampaignPlacement[] = [];
  let cursor: string | undefined;
  while (accepted.length < normalizedLimit) {
    const candidates = await db.mediaAssetPlacement.findMany({
      where: operationalMediaAssetPlacementWhere({
        ...(mediaAssetId ? { mediaAssetId } : {}),
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
          where: {
            requestId: { in: sourceJobIds },
            status: "succeeded",
          },
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
      if (!parseCommunityCampaignAuthoredCopy(placement.metadata)) continue;
      const evidence = parseCreativeMediaAuthorityEvidence(placement.metadata);
      const metadata = placement.metadata !== null &&
        typeof placement.metadata === "object" &&
        !Array.isArray(placement.metadata)
        ? placement.metadata as Record<string, unknown>
        : {};
      const v2Owned = typeof metadata.creativeRunId === "string" ||
        typeof metadata.creativeRunItemId === "string";
      if (evidence.kind === "invalid" || (v2Owned && evidence.kind !== "present")) continue;
      const upload = inspectOperatorUploadAuthority(placement.mediaAsset);
      if (upload) {
        const pinned = metadata.uploadedCampaignAuthority as Record<string, unknown> | undefined;
        const current = placement.mediaAsset.metadata as Record<string, unknown> | null;
        // INVARIANT: uploaded artwork serves only through its own verified byte provenance,
        // never by inventing a GenerationJob or weakening generated-media authority.
        if (!v2Owned && upload.publishable && mediaAssetPlatformStatus(current) === "approved" &&
            pinned?.schemaVersion === UPLOADED_CAMPAIGN_AUTHORITY_SCHEMA &&
            pinned.assetId === placement.mediaAssetId && pinned.sha256 === current?.sha256 &&
            pinned.storageKey === placement.mediaAsset.storageKey) accepted.push(placement);
        if (accepted.length === normalizedLimit) break;
        continue;
      }
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
        requireCompleteProviderAuthority: v2Owned,
      });
      if (authority.publishable) accepted.push(placement);
      if (accepted.length === normalizedLimit) break;
    }
    cursor = candidates.at(-1)?.id;
    if (!cursor || candidates.length < batchSize) break;
  }
  return accepted;
}
