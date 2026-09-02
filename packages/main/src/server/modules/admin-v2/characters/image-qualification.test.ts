import { describe, expect, it } from "vitest";
import {
  CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA,
  evaluateCharacterImageReviewAuthority,
} from "./image-qualification";

const quality = {
  artifactFree: true,
  singleSubject: true,
  intentMatch: true,
  noVisibleText: true,
};

const visualAuthority = {
  visualProfileId: "visual-1",
  visualProfileVersion: 3,
  visualProfileHash: "visual-hash-3",
  referenceSetRevisionId: "references-2",
  referenceSetSnapshotHash: "reference-hash-2",
};

function importedEvidence(
  overrides: Partial<typeof visualAuthority> = {},
) {
  return {
    quality,
    characterImageImport: {
      schemaVersion: CHARACTER_IMAGE_IMPORT_REVIEW_EVIDENCE_SCHEMA,
      source: "operator_upload",
      characterId: "character-1",
      assetId: "asset-1",
      ...visualAuthority,
      ...overrides,
    },
  };
}

describe("Character image qualification interface", () => {
  it("keeps an operator upload as a candidate until Review creates authority", () => {
    expect(evaluateCharacterImageReviewAuthority({
      source: "operator_upload",
      characterId: "character-1",
      assetId: "asset-1",
      assetAvailable: true,
      sourceAuthorityValid: true,
      bootstrapIdentity: false,
      review: null,
      currentVisualAuthority: visualAuthority,
    })).toEqual({
      qualified: false,
      blockers: ["review_pending"],
    });
  });

  it("routes a pre-identity library upload back to Visual Identity bootstrap", () => {
    expect(evaluateCharacterImageReviewAuthority({
      source: "operator_upload",
      characterId: "character-1",
      assetId: "asset-1",
      assetAvailable: true,
      sourceAuthorityValid: true,
      bootstrapIdentity: false,
      review: null,
      currentVisualAuthority: null,
    })).toEqual({
      qualified: false,
      blockers: ["visual_authority_missing", "review_pending"],
    });
  });

  it("qualifies a direct artifact Review pinned to the current sealed identity", () => {
    expect(evaluateCharacterImageReviewAuthority({
      source: "operator_upload",
      characterId: "character-1",
      assetId: "asset-1",
      assetAvailable: true,
      sourceAuthorityValid: true,
      bootstrapIdentity: false,
      review: {
        id: "review-1",
        artifactId: "asset-1",
        decision: "approved",
        identityConsistency: "passed",
        score: 94,
        evidence: importedEvidence(),
      },
      pinnedReviewDecisionId: "review-1",
      currentVisualAuthority: visualAuthority,
    })).toEqual({ qualified: true, blockers: [] });
  });

  it("invalidates an imported approval when Visual Identity authority changes", () => {
    expect(evaluateCharacterImageReviewAuthority({
      source: "operator_upload",
      characterId: "character-1",
      assetId: "asset-1",
      assetAvailable: true,
      sourceAuthorityValid: true,
      bootstrapIdentity: false,
      review: {
        id: "review-1",
        artifactId: "asset-1",
        decision: "approved",
        identityConsistency: "passed",
        score: 94,
        evidence: importedEvidence({ visualProfileVersion: 2 }),
      },
      currentVisualAuthority: visualAuthority,
    })).toEqual({
      qualified: false,
      blockers: ["visual_authority_changed"],
    });
  });

  it("does not let artifact-only Review replace generated Run lineage", () => {
    const result = evaluateCharacterImageReviewAuthority({
      source: "generation",
      characterId: "character-1",
      assetId: "asset-1",
      assetAvailable: true,
      sourceAuthorityValid: false,
      bootstrapIdentity: false,
      review: {
        id: "review-1",
        artifactId: "asset-1",
        decision: "approved",
        identityConsistency: "passed",
        score: 96,
        evidence: { quality },
      },
      currentVisualAuthority: null,
    });

    expect(result).toEqual({
      qualified: false,
      blockers: ["source_authority_invalid"],
    });
  });

  it("fails a Release pin when a newer Review decision owns the artifact", () => {
    const result = evaluateCharacterImageReviewAuthority({
      source: "operator_upload",
      characterId: "character-1",
      assetId: "asset-1",
      assetAvailable: true,
      sourceAuthorityValid: true,
      bootstrapIdentity: false,
      review: {
        id: "review-2",
        artifactId: "asset-1",
        decision: "approved",
        identityConsistency: "passed",
        score: 95,
        evidence: importedEvidence(),
      },
      pinnedReviewDecisionId: "review-1",
      currentVisualAuthority: visualAuthority,
    });

    expect(result.qualified).toBe(false);
    expect(result.blockers).toEqual([
      "review_authority_changed",
      "review_evidence_incomplete",
    ]);
  });
});
