import { Prisma } from "@prisma/client";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isSyntheticMediaAsset(metadata: unknown) {
  const marker = record(metadata).synthetic;
  return marker !== undefined && marker !== null && marker !== false;
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
  | "job_provider_mock"
  | "job_provider_untrusted"
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
  readonly latestAttemptProvider?: unknown;
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
  const platformStatus = record(record(input.metadata).platformAsset).status;
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
  if (isMockGenerationProvider(input.jobProvider)) {
    reasons.push("job_provider_mock");
  } else if (
    input.jobProvider !== undefined &&
    input.jobProvider !== null &&
    !isCustomerPublishableGenerationProvider(input.jobProvider)
  ) {
    reasons.push("job_provider_untrusted");
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
