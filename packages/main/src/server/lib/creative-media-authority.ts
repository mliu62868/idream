import {
  evaluateMediaAssetCustomerPublishability,
  type MediaAssetCustomerPublishabilityReason,
} from "./media-asset-authority";

export const CREATIVE_MEDIA_AUTHORITY_METADATA_KEY = "customerMediaAuthority";

export type CreativeMediaProviderSnapshot = {
  readonly sourceJobId: string | null;
  readonly jobProvider: string | null;
  readonly latestAttemptProvider: string | null;
};

export type CreativeMediaAuthorityReason =
  | MediaAssetCustomerPublishabilityReason
  | "provider_authority_evidence_invalid"
  | "source_job_missing"
  | "source_job_authority_changed"
  | "latest_attempt_provider_changed";

type CreativeMediaAuthorityEvidence =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "present";
      readonly snapshot: CreativeMediaProviderSnapshot;
    };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function authorityValueMissing(value: string | null) {
  return value === null || value.trim().length === 0;
}

export function parseCreativeMediaAuthorityEvidence(
  placementMetadata: unknown,
): CreativeMediaAuthorityEvidence {
  const metadata = record(placementMetadata);
  if (!(CREATIVE_MEDIA_AUTHORITY_METADATA_KEY in metadata)) {
    return { kind: "missing" };
  }
  const raw = record(metadata[CREATIVE_MEDIA_AUTHORITY_METADATA_KEY]);
  const sourceJobId = nullableString(raw.sourceJobId);
  const jobProvider = nullableString(raw.jobProvider);
  const latestAttemptProvider = nullableString(raw.latestAttemptProvider);
  if (
    sourceJobId === undefined ||
    jobProvider === undefined ||
    latestAttemptProvider === undefined
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "present",
    snapshot: {
      sourceJobId,
      jobProvider,
      latestAttemptProvider,
    },
  };
}

export function evaluateCreativeMediaAuthority(input: {
  readonly metadata: unknown;
  readonly current: CreativeMediaProviderSnapshot;
  readonly pinned?: CreativeMediaProviderSnapshot;
  readonly requireCompleteProviderAuthority?: boolean;
}) {
  const reasons: CreativeMediaAuthorityReason[] = [
    ...evaluateMediaAssetCustomerPublishability({
      metadata: input.metadata,
      pinnedProvider: input.pinned
        ? input.pinned.jobProvider
        : input.current.jobProvider,
      pinnedProviderRequired: input.requireCompleteProviderAuthority,
      jobProvider: input.current.jobProvider,
      jobProviderRequired: input.requireCompleteProviderAuthority,
      latestAttemptProvider: input.current.latestAttemptProvider,
      latestAttemptProviderRequired: input.requireCompleteProviderAuthority,
    }).reasons,
  ];
  if (input.requireCompleteProviderAuthority) {
    const snapshots = input.pinned
      ? [input.current, input.pinned]
      : [input.current];
    for (const snapshot of snapshots) {
      if (authorityValueMissing(snapshot.sourceJobId)) {
        reasons.push("source_job_missing");
      }
    }
  }
  if (input.pinned) {
    if (input.pinned.sourceJobId !== input.current.sourceJobId) {
      reasons.push("source_job_authority_changed");
    }
    if (
      input.pinned.latestAttemptProvider !==
      input.current.latestAttemptProvider
    ) {
      reasons.push("latest_attempt_provider_changed");
    }
  }
  return {
    publishable: reasons.length === 0,
    reasons: [...new Set(reasons)],
    snapshot: input.current,
  } as const;
}
