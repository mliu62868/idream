import { Prisma } from "@prisma/client";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA =
  "media-asset-blob-locator-v1";

export type MediaAssetBlobLocator =
  | {
      kind: "owned_storage";
      key: string;
    }
  | {
      kind: "shared_immutable";
      key: string;
      sourceAssetId: string;
    };

/**
 * Resolves physical bytes independently from MediaAsset review/publication
 * authority. `storageKey` remains unique ownership; a duplicate may instead
 * reference the same immutable object through an explicit, versioned locator.
 * Generic metadata.providerKey is intentionally not accepted here.
 */
export function resolveMediaAssetBlobLocator(asset: {
  storageKey?: string | null;
  metadata?: unknown;
}): MediaAssetBlobLocator | null {
  const storageKey = normalizedString(asset.storageKey);
  if (storageKey) return { kind: "owned_storage", key: storageKey };

  const metadata = record(asset.metadata);
  const locator = record(metadata.blobLocator);
  if (
    locator.schemaVersion !== SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA ||
    locator.kind !== "shared_immutable"
  ) {
    return null;
  }
  const key = normalizedString(locator.key);
  const sourceAssetId = normalizedString(locator.sourceAssetId);
  const lineageSourceAssetId = normalizedString(
    record(metadata.duplicateLineage).sourceAssetId,
  );
  if (
    !key ||
    !sourceAssetId ||
    lineageSourceAssetId !== sourceAssetId
  ) {
    return null;
  }
  return {
    kind: "shared_immutable",
    key,
    sourceAssetId,
  };
}

/**
 * Generation and serving authority must resolve to bytes, not merely to a UI
 * path. Relative `/media/...` URLs are projections of this authority and are
 * not a substitute for an owned/shared blob locator. Absolute HTTP(S) URLs
 * remain valid for explicitly remote assets.
 */
export function hasHydratableMediaBlobAuthority(asset: {
  storageKey?: string | null;
  url?: string | null;
  metadata?: unknown;
}) {
  if (resolveMediaAssetBlobLocator(asset)) return true;
  return typeof asset.url === "string" && /^https?:\/\//i.test(asset.url.trim());
}

function normalizedString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

export function isSyntheticMediaAsset(metadata: unknown) {
  const marker = record(metadata).synthetic;
  return marker !== undefined && marker !== null && marker !== false;
}

export function mediaAssetPlatformStatus(metadata: unknown) {
  const status = record(record(metadata).platformAsset).status;
  return typeof status === "string" ? status : null;
}

/**
 * Image Library archive/reject state is operational authority, not a display
 * label. Every Character consumer must reject these rows even when the
 * underlying media file still exists.
 */
export function isMediaAssetOperationalForAuthority(metadata: unknown) {
  const status = mediaAssetPlatformStatus(metadata);
  return status !== "archived" && status !== "rejected";
}

export type MediaAssetCustomerPublishabilityReason =
  | "metadata_synthetic"
  | "metadata_synthetic_marker_invalid"
  | "platform_asset_archived"
  | "platform_asset_rejected"
  | "pinned_provider_mock"
  | "pinned_provider_untrusted"
  | "pinned_provider_missing"
  | "pinned_provider_duplicate"
  | "pinned_provider_asset_mismatch"
  | "job_provider_missing"
  | "job_provider_mock"
  | "job_provider_untrusted"
  | "latest_successful_attempt_provider_missing"
  | "latest_attempt_provider_mock"
  | "latest_attempt_provider_untrusted"
  | "pinned_job_provider_mismatch";

export const CUSTOMER_PUBLISHABLE_GENERATION_PROVIDERS = [
  "backend",
  "comfyui",
  "pipeline",
  "pipeline-image",
] as const;

export function isMockGenerationProvider(value: unknown) {
  return typeof value === "string" &&
    value.trim().toLowerCase().startsWith("mock");
}

export function isCustomerPublishableGenerationProvider(value: unknown) {
  return typeof value === "string" &&
    CUSTOMER_PUBLISHABLE_GENERATION_PROVIDERS.some((provider) => provider === value);
}

export function evaluateMediaAssetCustomerPublishability(input: {
  readonly metadata: unknown;
  readonly pinnedProvider?: unknown;
  readonly pinnedProviderRequired?: boolean;
  readonly pinnedProviderDuplicate?: boolean;
  readonly pinnedProviderAssetMismatch?: boolean;
  readonly jobProvider?: unknown;
  readonly jobProviderRequired?: boolean;
  readonly latestAttemptProvider?: unknown;
  readonly latestAttemptProviderRequired?: boolean;
}) {
  const reasons: MediaAssetCustomerPublishabilityReason[] = [];
  const syntheticMarker = record(input.metadata).synthetic;
  if (syntheticMarker === true) {
    reasons.push("metadata_synthetic");
  } else if (
    syntheticMarker !== undefined &&
    syntheticMarker !== null &&
    syntheticMarker !== false
  ) {
    reasons.push("metadata_synthetic_marker_invalid");
  }
  const platformStatus = mediaAssetPlatformStatus(input.metadata);
  if (platformStatus === "archived") {
    reasons.push("platform_asset_archived");
  } else if (platformStatus === "rejected") {
    reasons.push("platform_asset_rejected");
  }
  if (isMockGenerationProvider(input.pinnedProvider)) {
    reasons.push("pinned_provider_mock");
  } else if (
    input.pinnedProvider !== undefined &&
    input.pinnedProvider !== null &&
    !isCustomerPublishableGenerationProvider(input.pinnedProvider)
  ) {
    reasons.push("pinned_provider_untrusted");
  }
  if (
    input.pinnedProviderRequired &&
    (input.pinnedProvider === undefined || input.pinnedProvider === null)
  ) {
    reasons.push("pinned_provider_missing");
  }
  if (input.pinnedProviderDuplicate) {
    reasons.push("pinned_provider_duplicate");
  }
  if (input.pinnedProviderAssetMismatch) {
    reasons.push("pinned_provider_asset_mismatch");
  }
  if (
    input.jobProviderRequired &&
    (input.jobProvider === undefined || input.jobProvider === null)
  ) {
    reasons.push("job_provider_missing");
  }
  if (isMockGenerationProvider(input.jobProvider)) {
    reasons.push("job_provider_mock");
  } else if (
    input.jobProvider !== undefined &&
    input.jobProvider !== null &&
      !isCustomerPublishableGenerationProvider(input.jobProvider)
  ) {
    reasons.push("job_provider_untrusted");
  }
  if (
    input.latestAttemptProviderRequired &&
    (
      input.latestAttemptProvider === undefined ||
      input.latestAttemptProvider === null
    )
  ) {
    reasons.push("latest_successful_attempt_provider_missing");
  }
  if (isMockGenerationProvider(input.latestAttemptProvider)) {
    reasons.push("latest_attempt_provider_mock");
  } else if (
    input.latestAttemptProvider !== undefined &&
    input.latestAttemptProvider !== null &&
    !isCustomerPublishableGenerationProvider(input.latestAttemptProvider)
  ) {
    reasons.push("latest_attempt_provider_untrusted");
  }
  if (
    Object.hasOwn(input, "pinnedProvider") &&
    Object.hasOwn(input, "jobProvider") &&
    input.pinnedProvider !== input.jobProvider
  ) {
    reasons.push("pinned_job_provider_mismatch");
  }
  return {
    publishable: reasons.length === 0,
    reasons,
  } as const;
}

export const nonSyntheticMediaAssetWhere = {
  OR: [
    {
      metadata: {
        path: ["synthetic"],
        equals: false,
      },
    },
    {
      metadata: {
        path: ["synthetic"],
        equals: Prisma.AnyNull,
      },
    },
  ],
} as const satisfies Prisma.MediaAssetWhereInput;

export const syntheticMediaAssetWhere = {
  NOT: nonSyntheticMediaAssetWhere,
} as const satisfies Prisma.MediaAssetWhereInput;
