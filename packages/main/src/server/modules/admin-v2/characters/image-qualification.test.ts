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
  it("allows an operator upload without a manual Review", () => {
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
      qualified: true,
      blockers: [],
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
      blockers: ["visual_authority_missing"],
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

  it("does not let historical review evidence block current operator selection", () => {
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
      qualified: true,
      blockers: [],
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

  it("keeps image eligibility independent of later manual decisions", () => {
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

    expect(result).toEqual({ qualified: true, blockers: [] });
  });
  it.each(["generation", "operator_upload"] as const)("still rejects unavailable or invalid %s sources without a review", (source) => {
    expect(evaluateCharacterImageReviewAuthority({
      source, characterId: "character-1", assetId: "asset-1", assetAvailable: false,
      sourceAuthorityValid: false, bootstrapIdentity: false, review: null,
      currentVisualAuthority: visualAuthority,
    })).toEqual({ qualified: false, blockers: ["asset_unavailable", "source_authority_invalid"] });
  });
});
