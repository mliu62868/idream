export type ReleaseCheckStatus = "passed" | "failed";

// SPEC: 这里只回答「哪些发布闸没过」，不回答「去哪修」。
// INTENT: 曾经每条 check 自带一个手拼的 admin URL，而本模块对运营台一无所知——于是拼出了
// `?tab=visual-identity` / `?tab=persona` / `?tab=overview` 三个 admin 根本没有的 tab，路线类还
// 指向了另一个页面。链接归 character-deep-link 的 tab/锚点表，唯一的消费者（workspace 投影）按
// blocker code 去查。
export interface ReleaseCheckResultView {
  readonly key: string;
  readonly status: ReleaseCheckStatus;
  readonly message: string;
}

export interface ReleaseBlocker {
  readonly code: string;
  readonly message: string;
}

export interface ReleaseReadinessInput {
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
): ReleaseCheckResultView {
  return {
    key,
    status: condition ? "passed" : "failed",
    message: condition ? "Passed" : failureMessage,
  };
}

export function evaluateReleaseReadiness(input: ReleaseReadinessInput) {
  const checks = [
    check(
      input.content.personaComplete,
      "persona_incomplete",
      "Persona snapshot is incomplete.",
    ),
    check(
      input.content.openingComplete,
      "opening_incomplete",
      "Opening message snapshot is incomplete.",
    ),
    check(
      input.visualIdentity !== null,
      "visual_identity_missing",
      "No immutable Visual Identity version is pinned.",
    ),
    check(
      (input.visualIdentity?.anchorCount ?? 0) > 0,
      "visual_anchor_missing",
      "Visual Identity has no available anchor asset.",
    ),
    check(
      input.visualIdentity?.requiredTraitsPresent === true,
      "visual_traits_incomplete",
      "Visual Identity is missing required stable traits.",
    ),
    check(
      input.visualIdentity?.snapshotSealed === true,
      "visual_identity_unsealed",
      "The active Visual Identity does not match its immutable snapshot hash.",
    ),
    check(
      input.referenceSet?.status === "active",
      "reference_set_not_active",
      "No active Reference Set revision is pinned.",
    ),
    check(
      input.referenceSet?.snapshotSealed === true,
      "reference_set_unsealed",
      "The active Reference Set revision has no immutable snapshot hash.",
    ),
    check(
      (input.referenceSet?.availableReferenceCount ?? 0) > 0,
      "reference_assets_unavailable",
      "The pinned Reference Set has no available asset.",
    ),
    check(
      input.routeQualification?.status === "qualified",
      "generation_route_unqualified",
      "No compatible image generation route is active.",
    ),
    check(
      input.routeQualification === null || input.routeQualification.stale === false,
      "generation_route_stale",
      "The active image generation route changed.",
    ),
    check(
      input.characterQa?.status === "passed",
      "character_qa_failed",
      "Character-level preview and QA has not passed.",
    ),
    check(
      input.snapshotHash === input.currentSnapshotHash,
      "snapshot_stale",
      "Release content changed after validation.",
    ),
    check(
      input.validatedPolicyVersion === input.currentPolicyVersion,
      "policy_stale",
      "Release policy changed after validation.",
    ),
  ] as const;
  const blockers = checks
    .filter((item) => item.status === "failed")
    .map((item) => ({ code: item.key, message: item.message }));
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
