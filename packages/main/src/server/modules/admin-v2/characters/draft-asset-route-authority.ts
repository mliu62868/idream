import type { Prisma } from "@prisma/client";

export const characterDraftAssetPurposes = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

export type CharacterDraftAssetPurpose = (typeof characterDraftAssetPurposes)[number];

export type DraftAssetRouteEntry = {
  readonly assetId: string;
  readonly runId: string | null;
  readonly itemId: string | null;
  readonly reviewDecisionId: string | null;
  readonly generationJobId: string | null;
  readonly bootstrapIdentity: boolean;
  readonly generationRouteFingerprint: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function draftAssetRouteEntries(
  value: Prisma.JsonValue,
): Partial<Record<CharacterDraftAssetPurpose, DraftAssetRouteEntry>> {
  const source = record(value);
  return Object.fromEntries(characterDraftAssetPurposes.flatMap((purpose) => {
    const raw = source[purpose];
    if (typeof raw === "string") {
      return [[purpose, {
        assetId: raw,
        runId: null,
        itemId: null,
        reviewDecisionId: null,
        generationJobId: null,
        bootstrapIdentity: false,
        generationRouteFingerprint: null,
      }]];
    }
    const entry = record(raw);
    if (typeof entry.assetId !== "string") return [];
    return [[purpose, {
      assetId: entry.assetId,
      runId: typeof entry.runId === "string" ? entry.runId : null,
      itemId: typeof entry.itemId === "string" ? entry.itemId : null,
      reviewDecisionId:
        typeof entry.reviewDecisionId === "string"
          ? entry.reviewDecisionId
          : null,
      generationJobId:
        typeof entry.generationJobId === "string"
          ? entry.generationJobId
          : null,
      bootstrapIdentity: entry.bootstrapIdentity === true,
      generationRouteFingerprint:
        typeof entry.generationRouteFingerprint === "string"
          ? entry.generationRouteFingerprint
          : null,
    }]];
  }));
}

/**
 * Draft selections remain immutable history when the global qualified route
 * advances. This projection only says whether each pointer can still authorize
 * the next QA/Release; it never clears or rewrites historical selections.
 */
export function evaluateDraftAssetRouteAuthority(
  value: Prisma.JsonValue,
  currentRouteFingerprint: string | null,
) {
  const entries = draftAssetRouteEntries(value);
  const selectedPurposes = characterDraftAssetPurposes.filter((purpose) => entries[purpose]);
  const missingPurposes = characterDraftAssetPurposes.filter((purpose) => !entries[purpose]);
  const invalidBootstrapPurposes = selectedPurposes.filter((purpose) =>
    purpose !== "character_cover" && entries[purpose]?.bootstrapIdentity === true
  );
  const stalePurposes = selectedPurposes.filter((purpose) => {
    const entry = entries[purpose]!;
    if (entry.bootstrapIdentity) return false;
    return currentRouteFingerprint === null ||
      entry.generationRouteFingerprint !== currentRouteFingerprint;
  });
  const routeCurrentByPurpose = Object.fromEntries(selectedPurposes.map((purpose) => [
    purpose,
    !stalePurposes.includes(purpose),
  ])) as Partial<Record<CharacterDraftAssetPurpose, boolean>>;

  return {
    status: selectedPurposes.length === 0
      ? "empty" as const
      : stalePurposes.length === 0
        ? "current" as const
        : currentRouteFingerprint === null
          ? "route_unavailable" as const
          : "stale" as const,
    currentRouteFingerprint,
    stalePurposes,
    missingPurposes,
    invalidBootstrapPurposes,
    recoveryPurpose: stalePurposes[0] ?? null,
    routeCurrentByPurpose,
    qaReady:
      missingPurposes.length === 0 &&
      invalidBootstrapPurposes.length === 0 &&
      stalePurposes.length === 0 &&
      currentRouteFingerprint !== null,
    qaBlockers: [
      ...(missingPurposes.length > 0 ? ["draft_asset_pack_incomplete"] : []),
      ...(invalidBootstrapPurposes.length > 0
        ? ["draft_asset_bootstrap_scope_invalid"]
        : []),
      ...(currentRouteFingerprint === null
        ? ["qualified_generation_route_missing"]
        : []),
      ...(stalePurposes.length > 0
        ? ["draft_asset_generation_route_stale"]
        : []),
    ],
  };
}
