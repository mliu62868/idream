import { describe, expect, it } from "vitest";
import {
  characterDraftImageSelectionRequestSchema,
  characterDraftImageSelectionResultSchema,
  characterImageReviewRequestSchema,
  characterImageSourceAssetSchema,
} from "./characters-asset-studio";
import { findAdminV2ApiOperation } from "../api-manifest";

describe("Character Asset Studio contracts", () => {
  it("selects a role-owned library image with optimistic Project version", () => {
    const request = {
      entityVersion: 4,
      purpose: "character_hero" as const,
      assetId: "asset-1",
      reason: "Use this existing library image in the next Release",
    };
    expect(characterDraftImageSelectionRequestSchema.parse(request)).toEqual(request);
    expect(characterDraftImageSelectionRequestSchema.safeParse({
      ...request,
      reason: "no",
    }).success).toBe(false);
  });

  it("returns the new Project version and preview continuation", () => {
    expect(characterDraftImageSelectionResultSchema.parse({
      characterId: "character-1",
      projectVersion: 5,
      selectedPurpose: "character_hero",
      selectedAssetId: "asset-2",
      draftImageAssetId: "asset-1",
      draftAssetPack: { character_cover: "asset-1", character_hero: "asset-2" },
      deepLink: "/admin/characters/character-1?tab=preview",
    })).toMatchObject({
      projectVersion: 5,
      draftImageAssetId: "asset-1",
      draftAssetPack: { character_cover: "asset-1", character_hero: "asset-2" },
    });
  });

  it("projects candidate through release-qualified states without inventing generation lineage", () => {
    expect(characterImageSourceAssetSchema.parse({
      id: "asset-upload-1",
      url: "/user-content/asset-upload-1/content.webp",
      thumbnailUrl: null,
      filename: "cover.webp",
      contentType: "image/webp",
      sizeBytes: 42_000,
      width: 1024,
      height: 1280,
      createdAt: "2026-09-02T12:00:00.000Z",
      qualification: {
        source: "operator_upload",
        state: "selectable",
        selectablePurposes: [
          "character_cover",
          "character_hero",
          "character_chat",
        ],
        selectedPurposes: [],
        releaseQualifiedPurposes: [],
        blockers: [],
        authority: {
          runId: null,
          itemId: null,
          reviewDecisionId: "review-1",
          generationJobId: null,
        },
        review: {
          id: "review-1",
          decision: "approved",
          identityConsistency: "passed",
          score: 94,
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          reason: "Matches the sealed Character identity",
          createdAt: "2026-09-02T12:01:00.000Z",
        },
      },
    }).qualification).toMatchObject({
      source: "operator_upload",
      state: "selectable",
      authority: {
        runId: null,
        itemId: null,
        generationJobId: null,
      },
    });
  });

  it("requires complete visible evidence before approving an imported image", () => {
    const review = {
      decision: "approved" as const,
      identityConsistency: "passed" as const,
      score: 94,
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "Matches the sealed Character identity",
    };
    expect(characterImageReviewRequestSchema.parse(review)).toEqual(review);
    expect(characterImageReviewRequestSchema.safeParse({
      ...review,
      quality: { ...review.quality, artifactFree: false },
    }).success).toBe(false);
  });

  it("registers the Character-scoped Review mutation in the Admin authority manifest", () => {
    expect(findAdminV2ApiOperation(
      "POST",
      "/api/v2/admin/characters/character-1/image-sources/asset-1/reviews",
    )).toMatchObject({
      id: "POST /api/v2/admin/characters/:id/image-sources/:assetId/reviews",
      authorization: {
        kind: "all_of",
        permissions: ["character.project.write", "creative.run.review"],
      },
      contract: {
        request: "characterImageReviewRequestSchema+idempotency-key",
        response: "characterImageReviewResultSchema",
      },
    });
  });
});
