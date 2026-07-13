import { describe, expect, it } from "vitest";
import { evaluateReleaseReadiness, validateServingPointer } from "./readiness";

const readyCandidate = {
  releaseId: "release-a",
  releaseCharacterId: "character-a",
  snapshotHash: "snapshot-a",
  currentSnapshotHash: "snapshot-a",
  validatedPolicyVersion: "release-policy-v1",
  currentPolicyVersion: "release-policy-v1",
  content: { personaComplete: true, openingComplete: true },
  visualIdentity: { version: 2, anchorCount: 1, requiredTraitsPresent: true, snapshotSealed: true },
  referenceSet: { revision: 3, status: "active", snapshotSealed: true, availableReferenceCount: 2 },
  routeQualification: { status: "qualified", stale: false },
  characterQa: { status: "passed" },
} as const;

describe("character release readiness", () => {
  it("returns ready only when every independent release gate passes", () => {
    expect(evaluateReleaseReadiness(readyCandidate)).toMatchObject({
      readiness: "ready",
      blockers: [],
      policyVersion: "release-policy-v1",
    });
  });

  it.each([
    ["missing persona", { content: { personaComplete: false, openingComplete: true } }, "persona_incomplete"],
    ["no anchor", { visualIdentity: { version: 2, anchorCount: 0, requiredTraitsPresent: true, snapshotSealed: true } }, "visual_anchor_missing"],
    ["visual snapshot drift", { visualIdentity: { version: 2, anchorCount: 1, requiredTraitsPresent: true, snapshotSealed: false } }, "visual_identity_unsealed"],
    ["no published references", { referenceSet: { revision: 3, status: "draft", snapshotSealed: true, availableReferenceCount: 2 } }, "reference_set_not_active"],
    ["unsealed references", { referenceSet: { revision: 3, status: "active", snapshotSealed: false, availableReferenceCount: 2 } }, "reference_set_unsealed"],
    ["route stale", { routeQualification: { status: "qualified", stale: true } }, "generation_route_stale"],
    ["QA failed", { characterQa: { status: "failed" } }, "character_qa_failed"],
    ["snapshot changed", { currentSnapshotHash: "snapshot-b" }, "snapshot_stale"],
    ["policy changed", { currentPolicyVersion: "release-policy-v2" }, "policy_stale"],
  ])("blocks %s with an actionable check", (_label, override, expectedCheck) => {
    const result = evaluateReleaseReadiness({ ...readyCandidate, ...override });
    expect(result.readiness).toBe("blocked");
    expect(result.blockers.map((blocker) => blocker.code)).toContain(expectedCheck);
  });

  it("rejects a serving pointer that targets another character or the scheduled pointer", () => {
    expect(() =>
      validateServingPointer({
        servingCharacterId: "character-a",
        releaseCharacterId: "character-b",
        currentReleaseId: null,
        scheduledReleaseId: null,
        candidateReleaseId: "release-b",
      }),
    ).toThrow(/same character/i);
    expect(() =>
      validateServingPointer({
        servingCharacterId: "character-a",
        releaseCharacterId: "character-a",
        currentReleaseId: "release-current",
        scheduledReleaseId: "release-b",
        candidateReleaseId: "release-b",
      }),
    ).toThrow(/scheduled/i);
  });
});
