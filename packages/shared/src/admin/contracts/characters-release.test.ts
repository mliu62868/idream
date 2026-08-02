import { describe, expect, it } from "vitest";
import { characterReleaseSchema } from "./characters-release";

const baseRelease = {
  id: "release-1",
  projectId: "project-1",
  revisionId: "revision-1",
  characterContentVersionId: "content-1",
  visualIdentity: {
    visualProfileId: "visual-1",
    visualProfileVersion: 1,
    anchorAssetId: "asset-1",
    referenceSetRevisionId: "refs-1",
  },
  generationRoute: {
    generationProfileKey: "profile-1",
    generationProfileVersion: "1",
    workflowKey: "workflow-1",
    workflowVersion: "1",
  },
  releaseOwnedPlacements: [],
  snapshotHash: "snapshot-1",
  policyVersion: "policy-1",
  status: "published" as const,
  publishedAt: null,
  supersedesId: null,
  rollbackOfReleaseId: null,
  version: 1,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

describe("Character Release historical coverage contract", () => {
  it("keeps an exact publishedAt requirement for non-legacy Releases", () => {
    expect(characterReleaseSchema.safeParse({ ...baseRelease, legacy: false }).success).toBe(false);
  });

  it("preserves a legacy live snapshot without inventing a publication timestamp", () => {
    expect(characterReleaseSchema.parse({ ...baseRelease, legacy: true })).toMatchObject({
      legacy: true,
      status: "published",
      publishedAt: null,
    });
  });
});
