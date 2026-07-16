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
  | "pinned_provider_mock"
  | "job_provider_mock"
  | "latest_attempt_provider_mock"
  | "pinned_job_provider_mismatch";

export function isMockGenerationProvider(value: unknown) {
  return typeof value === "string" &&
    value.trim().toLowerCase().startsWith("mock");
}

export function evaluateMediaAssetCustomerPublishability(input: {
  readonly metadata: unknown;
  readonly pinnedProvider?: unknown;
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
  if (isMockGenerationProvider(input.pinnedProvider)) {
    reasons.push("pinned_provider_mock");
  }
  if (isMockGenerationProvider(input.jobProvider)) {
    reasons.push("job_provider_mock");
  }
  if (isMockGenerationProvider(input.latestAttemptProvider)) {
    reasons.push("latest_attempt_provider_mock");
  }
  if (
    (input.pinnedProvider !== undefined || input.jobProvider !== undefined) &&
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
