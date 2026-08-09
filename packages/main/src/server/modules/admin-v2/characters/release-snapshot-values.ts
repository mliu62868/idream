import type { Prisma } from "@prisma/client";

export function releaseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function releaseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function releaseStringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export interface ReleasePlacement {
  readonly slotKey: string;
  readonly assetId: string;
  readonly runId: string | null;
  readonly itemId: string | null;
  readonly reviewDecisionId: string | null;
  readonly generationJobId: string | null;
  readonly bootstrapIdentity: boolean;
}

export function releasePlacements(value: Prisma.JsonValue): ReleasePlacement[] {
  const placements = releaseRecord(value).placements;
  if (!Array.isArray(placements)) return [];
  return placements.flatMap((item) => {
    const placement = releaseRecord(item);
    const slotKey = releaseString(placement.slotKey);
    const assetId = releaseString(placement.assetId);
    if (!slotKey || !assetId) return [];
    return [{
      slotKey,
      assetId,
      runId: releaseString(placement.runId),
      itemId: releaseString(placement.itemId),
      reviewDecisionId: releaseString(placement.reviewDecisionId),
      generationJobId: releaseString(placement.generationJobId),
      bootstrapIdentity: placement.bootstrapIdentity === true,
    }];
  });
}

export function requiredReleaseRoute(value: Prisma.JsonValue) {
  return releaseRecord(releaseRecord(value).requiredReleaseRoute);
}

export function hasCanonicalRequiredReleaseRoute(
  route: Record<string, unknown>,
) {
  const positiveVersion = (value: unknown) =>
    (typeof value === "number" && Number.isInteger(value) && value > 0) ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value !== "unavailable");
  return releaseString(route.routeFingerprint) !== null &&
    releaseString(route.matrixKey) !== null &&
    releaseString(route.generationProfileKey) !== null &&
    positiveVersion(route.generationProfileVersion) &&
    releaseString(route.workflowKey) !== null &&
    positiveVersion(route.workflowVersion);
}

export function releaseAvatarAssetId(value: Prisma.JsonValue): string | null {
  return releasePlacements(value)
    .find((item) => item.slotKey === "character_avatar")?.assetId ?? null;
}
