import { describe, expect, it } from "vitest";
import { characterReleaseSchema } from "@idream/shared/admin";
import { characterReleaseContract } from "./character-release-contract";

describe("characterReleaseContract", () => {
  it("projects the canonical database row into the declared Admin v2 response", () => {
    const createdAt = new Date("2026-07-16T12:00:00.000Z");
    const updatedAt = new Date("2026-07-16T12:01:00.000Z");
    const release = characterReleaseContract({
      id: "release-1",
      projectId: "project-1",
      revisionId: "revision-1",
      characterContentVersionId: "content-1",
      visualProfileId: "profile-1",
      visualProfileVersion: 3,
      referenceSetRevisionId: "reference-set-1",
      generationProvenance: {
        schemaVersion: "character-release-generation-provenance-v2",
        policyVersion: "character-release-policy-v2",
        requiredReleaseRoute: {
          generationProfileKey: "chat-image-edit",
          generationProfileVersion: 2,
          workflowKey: "qwen-image-edit-img2img",
          workflowVersion: 1,
        },
      },
      releasePlacementManifest: {
        schemaVersion: 2,
        placements: [
          {
            slotKey: "character_avatar",
            slotVersion: 2,
            assetId: "asset-avatar",
            runId: "run-avatar",
            itemId: "item-avatar",
            reviewDecisionId: "decision-avatar",
            generationJobId: "job-avatar",
          },
          {
            slotKey: "character_hero",
            slotVersion: 1,
            assetId: "asset-hero",
            runId: "run-hero",
            itemId: "item-hero",
            reviewDecisionId: "decision-hero",
            generationJobId: "job-hero",
          },
          {
            slotKey: "character_chat",
            slotVersion: 1,
            assetId: "asset-chat",
            runId: "run-chat",
            itemId: "item-chat",
            reviewDecisionId: "decision-chat",
            generationJobId: "job-chat",
          },
        ],
      },
      snapshotHash: "snapshot-1",
      legacy: false,
      status: "in_review",
      publishedAt: null,
      supersedesId: null,
      rollbackOfReleaseId: null,
      version: 0,
      createdAt,
      updatedAt,
    });

    expect(characterReleaseSchema.parse(release)).toEqual({
      id: "release-1",
      projectId: "project-1",
      revisionId: "revision-1",
      characterContentVersionId: "content-1",
      visualIdentity: {
        visualProfileId: "profile-1",
        visualProfileVersion: 3,
        anchorAssetId: "asset-avatar",
        referenceSetRevisionId: "reference-set-1",
      },
      generationRoute: {
        generationProfileKey: "chat-image-edit",
        generationProfileVersion: "2",
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: "1",
      },
      releaseOwnedPlacements: [
        {
          slotKey: "character_avatar",
          slotVersion: 2,
          assetId: "asset-avatar",
        },
        {
          slotKey: "character_hero",
          slotVersion: 1,
          assetId: "asset-hero",
        },
        {
          slotKey: "character_chat",
          slotVersion: 1,
          assetId: "asset-chat",
        },
      ],
      snapshotHash: "snapshot-1",
      policyVersion: "character-release-policy-v2",
      legacy: false,
      status: "in_review",
      publishedAt: null,
      supersedesId: null,
      rollbackOfReleaseId: null,
      version: 0,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(characterReleaseContract(release)).toEqual(release);
  });

  it("fails closed instead of inventing strict authority for a malformed non-legacy row", () => {
    expect(() => characterReleaseContract({
      id: "release-malformed",
      projectId: "project-1",
      revisionId: "revision-1",
      characterContentVersionId: "content-1",
      generationProvenance: {
        policyVersion: "character-release-policy-v2",
      },
      releasePlacementManifest: {
        placements: [{
          slotKey: "character_cover",
          assetId: "asset-1",
        }],
      },
      snapshotHash: "snapshot-malformed",
      legacy: false,
      status: "in_review",
      publishedAt: null,
      supersedesId: null,
      rollbackOfReleaseId: null,
      version: 1,
      createdAt: new Date("2026-07-16T12:00:00.000Z"),
      updatedAt: new Date("2026-07-16T12:01:00.000Z"),
    })).toThrow("missing strict v2 authority");
  });

  it("rejects strict raw route versions that are placeholder values", () => {
    const createdAt = new Date("2026-07-16T12:00:00.000Z");
    expect(() => characterReleaseContract({
      id: "release-placeholder-route",
      projectId: "project-1",
      revisionId: "revision-1",
      characterContentVersionId: "content-1",
      visualProfileId: "profile-1",
      visualProfileVersion: 1,
      referenceSetRevisionId: "reference-set-1",
      generationProvenance: {
        schemaVersion: "character-release-generation-provenance-v2",
        policyVersion: "character-release-policy-v2",
        requiredReleaseRoute: {
          generationProfileKey: "profile",
          generationProfileVersion: "unavailable",
          workflowKey: "workflow",
          workflowVersion: 1,
        },
      },
      releasePlacementManifest: {
        schemaVersion: 2,
        placements: [
          {
            slotKey: "character_avatar",
            slotVersion: 1,
            assetId: "asset-avatar",
            runId: "run-avatar",
            itemId: "item-avatar",
            reviewDecisionId: "decision-avatar",
            generationJobId: "job-avatar",
          },
          {
            slotKey: "character_hero",
            slotVersion: 1,
            assetId: "asset-hero",
            runId: "run-hero",
            itemId: "item-hero",
            reviewDecisionId: "decision-hero",
            generationJobId: "job-hero",
          },
          {
            slotKey: "character_chat",
            slotVersion: 1,
            assetId: "asset-chat",
            runId: "run-chat",
            itemId: "item-chat",
            reviewDecisionId: "decision-chat",
            generationJobId: "job-chat",
          },
        ],
      },
      snapshotHash: "snapshot-placeholder-route",
      legacy: false,
      status: "in_review",
      publishedAt: null,
      supersedesId: null,
      rollbackOfReleaseId: null,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    })).toThrow("missing strict v2 authority");
  });

  it("rejects an already-shaped non-legacy response that lacks the exact three-slot authority", () => {
    expect(() => characterReleaseContract({
      id: "release-shaped-malformed",
      projectId: "project-1",
      revisionId: "revision-1",
      characterContentVersionId: "content-1",
      visualIdentity: {
        visualProfileId: "unavailable",
        visualProfileVersion: 1,
        anchorAssetId: "asset-1",
        referenceSetRevisionId: "unavailable",
      },
      generationRoute: {
        generationProfileKey: "unavailable",
        generationProfileVersion: "unavailable",
        workflowKey: "unavailable",
        workflowVersion: "unavailable",
      },
      releaseOwnedPlacements: [{
        slotKey: "character_cover",
        slotVersion: 1,
        assetId: "asset-1",
      }],
      snapshotHash: "snapshot-shaped-malformed",
      policyVersion: "character-release-policy-v2",
      legacy: false,
      status: "in_review",
      publishedAt: null,
      supersedesId: null,
      rollbackOfReleaseId: null,
      version: 1,
      createdAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:01:00.000Z",
    })).toThrow("missing strict v2 authority");
  });

  it("keeps explicit legacy editorial rows compatible without pretending they are strict v2", () => {
    expect(characterReleaseContract({
      id: "release-legacy",
      projectId: "project-1",
      revisionId: "revision-1",
      characterContentVersionId: "content-1",
      generationProvenance: {
        policyVersion: "public-catalog-editorial-import-v1",
      },
      releasePlacementManifest: [{
        placementId: "character_avatar",
        assetId: "asset-legacy",
      }],
      snapshotHash: "snapshot-legacy",
      legacy: true,
      status: "published",
      publishedAt: new Date("2026-07-16T12:01:00.000Z"),
      supersedesId: null,
      rollbackOfReleaseId: null,
      version: 1,
      createdAt: new Date("2026-07-16T12:00:00.000Z"),
      updatedAt: new Date("2026-07-16T12:01:00.000Z"),
    })).toMatchObject({
      legacy: true,
      releaseOwnedPlacements: [{
        slotKey: "character_avatar",
        slotVersion: 1,
        assetId: "asset-legacy",
      }],
    });
  });
});
