export type ReleaseCheckStatus = "passed" | "failed";

export interface ReleaseCheckResultView {
  readonly key: string;
  readonly status: ReleaseCheckStatus;
  readonly message: string;
  readonly deepLink: string;
}

export interface ReleaseBlocker {
  readonly code: string;
  readonly message: string;
  readonly deepLink: string;
}

export interface ReleaseReadinessInput {
  readonly releaseId: string;
  readonly releaseCharacterId: string;
  readonly snapshotHash: string;
  readonly currentSnapshotHash: string;
  readonly validatedPolicyVersion: string;
  readonly currentPolicyVersion: string;
  readonly content: {
    readonly personaComplete: boolean;
    readonly openingComplete: boolean;
  };
  readonly visualIdentity: {
    readonly version: number;
    readonly anchorCount: number;
    readonly requiredTraitsPresent: boolean;
    readonly snapshotSealed: boolean;
  } | null;
  readonly referenceSet: {
    readonly revision: number;
    readonly status: string;
    readonly snapshotSealed: boolean;
    readonly availableReferenceCount: number;
  } | null;
  readonly routeQualification: {
    readonly status: string;
    readonly stale: boolean;
  } | null;
  readonly characterQa: { readonly status: string } | null;
}

function check(
  condition: boolean,
  key: string,
  failureMessage: string,
  deepLink: string,
): ReleaseCheckResultView {
  return {
    key,
    status: condition ? "passed" : "failed",
    message: condition ? "Passed" : failureMessage,
    deepLink,
  };
}

export function evaluateReleaseReadiness(input: ReleaseReadinessInput) {
  const checks = [
    check(
      input.content.personaComplete,
      "persona_incomplete",
      "Persona snapshot is incomplete.",
      `/admin/characters/${input.releaseCharacterId}?tab=persona`,
    ),
    check(
      input.content.openingComplete,
      "opening_incomplete",
      "Opening message snapshot is incomplete.",
      `/admin/characters/${input.releaseCharacterId}?tab=persona`,
    ),
    check(
      input.visualIdentity !== null,
      "visual_identity_missing",
      "No immutable Visual Identity version is pinned.",
      `/admin/characters/${input.releaseCharacterId}?tab=visual-identity`,
    ),
    check(
      (input.visualIdentity?.anchorCount ?? 0) > 0,
      "visual_anchor_missing",
      "Visual Identity has no available anchor asset.",
      `/admin/characters/${input.releaseCharacterId}?tab=visual-identity`,
    ),
    check(
      input.visualIdentity?.requiredTraitsPresent === true,
      "visual_traits_incomplete",
      "Visual Identity is missing required stable traits.",
      `/admin/characters/${input.releaseCharacterId}?tab=visual-identity`,
    ),
    check(
      input.visualIdentity?.snapshotSealed === true,
      "visual_identity_unsealed",
      "The active Visual Identity does not match its immutable snapshot hash.",
      `/admin/characters/${input.releaseCharacterId}?tab=visual-identity`,
    ),
    check(
      input.referenceSet?.status === "active",
      "reference_set_not_active",
      "No active Reference Set revision is pinned.",
      `/admin/characters/${input.releaseCharacterId}?tab=visual-identity`,
    ),
    check(
      input.referenceSet?.snapshotSealed === true,
      "reference_set_unsealed",
      "The active Reference Set revision has no immutable snapshot hash.",
      `/admin/characters/${input.releaseCharacterId}?tab=visual-identity`,
    ),
    check(
      (input.referenceSet?.availableReferenceCount ?? 0) > 0,
      "reference_assets_unavailable",
      "The pinned Reference Set has no available asset.",
      `/admin/characters/${input.releaseCharacterId}?tab=visual-identity`,
    ),
    check(
      input.routeQualification?.status === "qualified",
      "generation_route_unqualified",
      "No compatible image generation route is active.",
      `/admin/ops/profiles?characterId=${input.releaseCharacterId}`,
    ),
    check(
      input.routeQualification === null || input.routeQualification.stale === false,
      "generation_route_stale",
      "The active image generation route changed.",
      `/admin/ops/profiles?characterId=${input.releaseCharacterId}`,
    ),
    check(
      input.characterQa?.status === "passed",
      "character_qa_failed",
      "Character-level preview and QA has not passed.",
      `/admin/characters/${input.releaseCharacterId}?tab=preview`,
    ),
    check(
      input.snapshotHash === input.currentSnapshotHash,
      "snapshot_stale",
      "Release content changed after validation.",
      `/admin/characters/${input.releaseCharacterId}?tab=overview`,
    ),
    check(
      input.validatedPolicyVersion === input.currentPolicyVersion,
      "policy_stale",
      "Release policy changed after validation.",
      `/admin/characters/${input.releaseCharacterId}?tab=overview`,
    ),
  ] as const;
  const blockers = checks
    .filter((item) => item.status === "failed")
    .map((item) => ({ code: item.key, message: item.message, deepLink: item.deepLink }));
  return {
    readiness: blockers.length === 0 ? ("ready" as const) : ("blocked" as const),
    checks,
    blockers,
    policyVersion: input.currentPolicyVersion,
    entityVersion: input.visualIdentity?.version ?? 0,
    lastVerifiedAt: null,
  };
}

export function validateServingPointer(input: {
  readonly servingCharacterId: string;
  readonly releaseCharacterId: string;
  readonly currentReleaseId: string | null;
  readonly scheduledReleaseId: string | null;
  readonly candidateReleaseId: string;
}) {
  if (input.servingCharacterId !== input.releaseCharacterId) {
    throw new Error("Serving pointer and Release must belong to the same character");
  }
  if (input.scheduledReleaseId === input.candidateReleaseId) {
    throw new Error("Scheduled pointer must be cleared in the same publication transaction");
  }
  if (input.currentReleaseId === input.candidateReleaseId) {
    throw new Error("Candidate Release is already the current serving pointer");
  }
}
