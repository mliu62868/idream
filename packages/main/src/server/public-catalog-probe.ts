import type { Prisma, PrismaClient } from "@prisma/client";
import { isSyntheticMediaAsset } from "@/server/lib/media-asset-authority";
import {
  publicCharacterAudienceWhere,
  publicCollectionAudienceWhere,
  publicFeedbackAudienceWhere,
  rawPublicCharacterWhere,
  rawPublicCollectionWhere,
  rawPublicFeedbackWhere,
} from "@/server/modules/ourdream/public-content-audience";

type CatalogProbeDb = PrismaClient | Prisma.TransactionClient;

export type PublicCatalogProbeOptions = {
  report: string | null;
  maxDuplicateImageRatio: number;
  maxPublicMetric: number;
  maxIssues: number;
};

export type CatalogIssue = {
  severity: "fail" | "warn";
  entity: "character" | "collection" | "creator" | "feedback" | "catalog";
  id: string;
  field: string;
  message: string;
  value?: string | number | null;
};

export type PublicCatalogProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  counts: {
    publicCharacters: number;
    rawPublicCharacters: number;
    excludedPublicCharacters: number;
    publicCollections: number;
    rawPublicCollections: number;
    excludedPublicCollections: number;
    publicCreators: number;
    publicFeedbackItems: number;
    rawPublicFeedbackItems: number;
    excludedPublicFeedbackItems: number;
    distinctImages: number;
  };
  thresholds: {
    maxDuplicateImageRatio: number;
    maxPublicMetric: number;
  };
  issueTotals: {
    total: number;
    fail: number;
    warn: number;
  };
  issues: CatalogIssue[];
  error: { code: string; message: string; retryable?: boolean } | null;
};

const fixturePatterns = [
  {
    label: "e2e/test fixture marker",
    regex: /\b(e2e|test fixture|integration tests|api tests)\b|e2e-|test\.local/i,
  },
  {
    label: "generated numeric dreamer name",
    regex: /\bdreamer\s+\d{8,}/i,
  },
  {
    label: "audit/test user marker",
    regex: /\bpm audit\b|audit user|chrome\s+(handoff|collection|collection auditor|refresh|content ops|pm|e2e|roadmap|anonymous|audit)|playwright/i,
  },
  {
    label: "verification fixture copy",
    regex: /seeded for|used to verify|profile reporting|community dreamer/i,
  },
] as const;

const characterInclude = {
  creator: {
    select: {
      id: true,
      email: true,
      displayName: true,
      name: true,
      dataClass: true,
    },
  },
  imageAsset: {
    select: {
      id: true,
      url: true,
      thumbnailUrl: true,
      prompt: true,
      type: true,
      deletedAt: true,
      visibility: true,
      safetyStatus: true,
      metadata: true,
    },
  },
  serving: {
    select: {
      state: true,
      currentRelease: {
        select: {
          id: true,
          status: true,
          publishedAt: true,
          readiness: true,
          legacy: true,
          releasePlacementManifest: true,
          publicCatalogQualification: {
            select: {
              kind: true,
              validationRunId: true,
              revokedAt: true,
            },
          },
        },
      },
    },
  },
  stats: {
    select: {
      likesCount: true,
      chatsCount: true,
      viewsCount: true,
    },
  },
} as const satisfies Prisma.CharacterInclude;

const collectionInclude = {
  owner: {
    select: {
      id: true,
      email: true,
      displayName: true,
      name: true,
      dataClass: true,
    },
  },
  items: {
    include: {
      mediaAsset: {
        select: {
          id: true,
          prompt: true,
          url: true,
          thumbnailUrl: true,
          deletedAt: true,
          visibility: true,
          safetyStatus: true,
          metadata: true,
        },
      },
    },
  },
} as const satisfies Prisma.MediaCollectionInclude;

const feedbackInclude = {
  createdBy: {
    select: {
      id: true,
      email: true,
      displayName: true,
      name: true,
      dataClass: true,
    },
  },
} as const satisfies Prisma.ProductFeedbackItemInclude;

function characterAvatarAssetId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const placements = (value as { placements?: unknown }).placements;
  if (!Array.isArray(placements)) return null;
  const avatars = placements.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const placement = item as Record<string, unknown>;
    return placement.slotKey === "character_avatar" &&
      typeof placement.assetId === "string" &&
      placement.assetId.length > 0;
  }) as Array<Record<string, unknown>>;
  return avatars.length === 1 ? avatars[0].assetId as string : null;
}

export async function runPublicCatalogProbe(
  db: CatalogProbeDb,
  options: PublicCatalogProbeOptions,
): Promise<PublicCatalogProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const characters = await db.character.findMany({
      where: publicCharacterAudienceWhere,
      include: characterInclude,
      orderBy: { createdAt: "desc" },
    });
    const rawCharacters = await db.character.findMany({
      where: rawPublicCharacterWhere,
      include: characterInclude,
      orderBy: { createdAt: "desc" },
    });
    const collections = await db.mediaCollection.findMany({
      where: publicCollectionAudienceWhere,
      include: collectionInclude,
      orderBy: { createdAt: "desc" },
    });
    const rawCollections = await db.mediaCollection.findMany({
      where: rawPublicCollectionWhere,
      include: collectionInclude,
      orderBy: { createdAt: "desc" },
    });
    const feedbackItems = await db.productFeedbackItem.findMany({
      where: publicFeedbackAudienceWhere,
      include: feedbackInclude,
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    });
    const rawFeedbackItems = await db.productFeedbackItem.findMany({
      where: rawPublicFeedbackWhere,
      include: feedbackInclude,
      orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    });

    const issues: CatalogIssue[] = [];
    const creatorIds = new Set<string>();
    const imageCounts = new Map<string, number>();
    const characterAudienceIds = new Set(characters.map((character) => character.id));
    const collectionAudienceIds = new Set(collections.map((collection) => collection.id));
    const feedbackAudienceIds = new Set(feedbackItems.map((item) => item.id));
    const excludedCharacters = rawCharacters.filter(
      (character) => !characterAudienceIds.has(character.id),
    );
    const excludedCollections = rawCollections.filter(
      (collection) => !collectionAudienceIds.has(collection.id),
    );
    const excludedFeedbackItems = rawFeedbackItems.filter(
      (item) => !feedbackAudienceIds.has(item.id),
    );

    for (const character of excludedCharacters) {
      const syntheticImage = isSyntheticMediaAsset(character.imageAsset?.metadata);
      const currentRelease = character.serving?.currentRelease ?? null;
      const qualification = currentRelease?.publicCatalogQualification ?? null;
      const imageUnavailable =
        !character.imageAsset ||
        character.imageAsset.type !== "image" ||
        character.imageAsset.deletedAt !== null ||
        character.imageAsset.visibility !== "public_pack" ||
        character.imageAsset.safetyStatus !== "passed";
      const releaseProjectionUnavailable =
        Boolean(currentRelease) &&
        characterAvatarAssetId(currentRelease?.releasePlacementManifest) !==
          (character.imageAsset?.id ?? null);
      const qualificationUnavailable =
        character.serving?.state !== "live" ||
        !currentRelease ||
        currentRelease.status !== "published" ||
        currentRelease.publishedAt === null ||
        !qualification ||
        qualification.revokedAt !== null ||
        (
          currentRelease.legacy
            ? qualification.kind !== "editorial_import" ||
              qualification.validationRunId !== null
            : currentRelease.readiness !== "ready" ||
              qualification.kind !== "generated_release" ||
              qualification.validationRunId === null
        );
      issues.push({
        severity: "fail",
        entity: "character",
        id: character.id,
        field:
          syntheticImage || imageUnavailable
            ? "imageAsset"
            : releaseProjectionUnavailable
              ? "releaseProjection"
            : qualificationUnavailable
              ? "publicQualification"
              : "audience",
        message: syntheticImage
          ? "Public character references a synthetic image authority."
          : imageUnavailable
            ? "Public character has no complete publishable image authority."
            : releaseProjectionUnavailable
              ? "Public character image does not match the exact current Release avatar."
            : qualificationUnavailable
              ? "Public character has no exact live Release qualification."
              : "Public user character is owned by a non-customer actor.",
        value: syntheticImage
          ? character.imageAsset?.id ?? "missing_image_asset"
          : imageUnavailable
            ? character.imageAsset?.id ?? "missing_image_asset"
            : releaseProjectionUnavailable
              ? characterAvatarAssetId(currentRelease?.releasePlacementManifest) ??
                "missing_release_avatar"
            : qualificationUnavailable
              ? currentRelease?.id ?? "missing_current_release"
              : character.creator?.dataClass ?? "missing_creator",
      });
    }
    for (const collection of excludedCollections) {
      const syntheticItem = collection.items.find(
        (item) => isSyntheticMediaAsset(item.mediaAsset.metadata),
      );
      const unavailableItem = collection.items.find(
        (item) =>
          item.mediaAsset.deletedAt !== null ||
          item.mediaAsset.visibility !== "public_pack" ||
          item.mediaAsset.safetyStatus !== "passed",
      );
      issues.push({
        severity: "fail",
        entity: "collection",
        id: collection.id,
        field:
          collection.items.length === 0 || syntheticItem || unavailableItem
            ? "items"
            : "audience",
        message:
          collection.items.length === 0
            ? "Public collection is empty."
            : syntheticItem
              ? "Public collection contains a synthetic media authority."
              : unavailableItem
                ? "Public collection contains unavailable or unreviewed media."
                : "Public user collection is owned by a non-customer actor.",
        value:
          syntheticItem?.mediaAsset.id ??
          unavailableItem?.mediaAsset.id ??
          (collection.items.length === 0 ? 0 : collection.owner.dataClass),
      });
    }
    for (const item of excludedFeedbackItems) {
      issues.push({
        severity: "fail",
        entity: "feedback",
        id: item.id,
        field: "audience",
        message: "Non-official feedback is owned by a non-customer actor.",
        value: item.createdBy?.dataClass ?? "missing_creator",
      });
    }

    for (const character of characters) {
      if (character.creatorId) creatorIds.add(character.creatorId);
      const imageKey = character.imageAsset?.url ?? character.imageAsset?.thumbnailUrl ?? null;
      if (imageKey) imageCounts.set(imageKey, (imageCounts.get(imageKey) ?? 0) + 1);

      checkText(issues, "character", character.id, "id", character.id);
      checkText(issues, "character", character.id, "name", character.name);
      checkText(issues, "character", character.id, "description", character.description);
      checkText(issues, "character", character.id, "imagePrompt", character.imageAsset?.prompt ?? null);

      if (character.creator) {
        checkText(issues, "creator", character.creator.id, "email", character.creator.email);
        checkText(
          issues,
          "creator",
          character.creator.id,
          "displayName",
          character.creator.displayName ?? character.creator.name ?? null,
        );
      }

      checkMetric(
        issues,
        character.id,
        "likesCount",
        character.stats?.likesCount ?? 0,
        options.maxPublicMetric,
      );
      checkMetric(
        issues,
        character.id,
        "chatsCount",
        character.stats?.chatsCount ?? 0,
        options.maxPublicMetric,
      );
    }

    for (const collection of collections) {
      creatorIds.add(collection.ownerId);
      checkText(issues, "collection", collection.id, "id", collection.id);
      checkText(issues, "collection", collection.id, "name", collection.name);
      checkText(issues, "creator", collection.owner.id, "email", collection.owner.email);
      checkText(
        issues,
        "creator",
        collection.owner.id,
        "displayName",
        collection.owner.displayName ?? collection.owner.name ?? null,
      );
      for (const item of collection.items) {
        checkText(
          issues,
          "collection",
          collection.id,
          `media.${item.mediaAsset.id}.prompt`,
          item.mediaAsset.prompt,
        );
        checkText(
          issues,
          "collection",
          collection.id,
          `media.${item.mediaAsset.id}.url`,
          item.mediaAsset.url ?? item.mediaAsset.thumbnailUrl ?? null,
        );
      }
    }

    for (const item of feedbackItems) {
      if (item.createdById) creatorIds.add(item.createdById);
      checkText(issues, "feedback", item.id, "id", item.id);
      checkText(issues, "feedback", item.id, "title", item.title);
      checkText(issues, "feedback", item.id, "description", item.description);
      if (item.createdBy) {
        checkText(issues, "creator", item.createdBy.id, "email", item.createdBy.email);
        checkText(
          issues,
          "creator",
          item.createdBy.id,
          "displayName",
          item.createdBy.displayName ?? item.createdBy.name ?? null,
        );
      }
    }

    const duplicateImageIssue = duplicateImageConcentrationIssue(
      imageCounts,
      characters.length,
      options.maxDuplicateImageRatio,
    );
    if (duplicateImageIssue) issues.push(duplicateImageIssue);

    const failCount = issues.filter((issue) => issue.severity === "fail").length;
    const warnCount = issues.length - failCount;
    const ok = failCount === 0;

    return {
      ok,
      checkedAt,
      durationMs: Date.now() - startedAt,
      counts: {
        publicCharacters: characters.length,
        rawPublicCharacters: rawCharacters.length,
        excludedPublicCharacters: excludedCharacters.length,
        publicCollections: collections.length,
        rawPublicCollections: rawCollections.length,
        excludedPublicCollections: excludedCollections.length,
        publicCreators: creatorIds.size,
        publicFeedbackItems: feedbackItems.length,
        rawPublicFeedbackItems: rawFeedbackItems.length,
        excludedPublicFeedbackItems: excludedFeedbackItems.length,
        distinctImages: imageCounts.size,
      },
      thresholds: {
        maxDuplicateImageRatio: options.maxDuplicateImageRatio,
        maxPublicMetric: options.maxPublicMetric,
      },
      issueTotals: {
        total: issues.length,
        fail: failCount,
        warn: warnCount,
      },
      issues: issues.slice(0, options.maxIssues),
      error: ok
        ? null
        : {
            code: "public_catalog_probe_failed",
            message: `${failCount} launch-blocking public catalog issue(s) found.`,
            retryable: false,
          },
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      durationMs: Date.now() - startedAt,
      counts: emptyCounts(),
      thresholds: {
        maxDuplicateImageRatio: options.maxDuplicateImageRatio,
        maxPublicMetric: options.maxPublicMetric,
      },
      issueTotals: {
        total: 0,
        fail: 0,
        warn: 0,
      },
      issues: [],
      error: {
        code: "public_catalog_probe_error",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

function emptyCounts(): PublicCatalogProbeReport["counts"] {
  return {
    publicCharacters: 0,
    rawPublicCharacters: 0,
    excludedPublicCharacters: 0,
    publicCollections: 0,
    rawPublicCollections: 0,
    excludedPublicCollections: 0,
    publicCreators: 0,
    publicFeedbackItems: 0,
    rawPublicFeedbackItems: 0,
    excludedPublicFeedbackItems: 0,
    distinctImages: 0,
  };
}

function checkText(
  issues: CatalogIssue[],
  entity: "character" | "collection" | "creator" | "feedback",
  id: string,
  field: string,
  value: string | null,
) {
  if (!value) return;
  for (const pattern of fixturePatterns) {
    if (!pattern.regex.test(value)) continue;
    issues.push({
      severity: "fail",
      entity,
      id,
      field,
      message: `Public catalog contains ${pattern.label}.`,
      value: truncate(value),
    });
  }
}

function checkMetric(
  issues: CatalogIssue[],
  id: string,
  field: "likesCount" | "chatsCount",
  value: number,
  max: number,
) {
  if (value <= max) return;
  issues.push({
    severity: "fail",
    entity: "character",
    id,
    field,
    message: `Public ${field} exceeds launch hygiene threshold.`,
    value,
  });
}

function duplicateImageConcentrationIssue(
  imageCounts: Map<string, number>,
  total: number,
  maxRatio: number,
): CatalogIssue | null {
  if (total < 8 || imageCounts.size === 0) return null;
  const [image, count] = [...imageCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (!image || count < 5) return null;
  const ratio = count / total;
  if (ratio <= maxRatio) return null;
  return {
    severity: "fail",
    entity: "catalog",
    id: "image-concentration",
    field: "imageAsset.url",
    message: `One image is reused by ${count}/${total} public characters.`,
    value: truncate(image),
  };
}

function truncate(value: string) {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}
