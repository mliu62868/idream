import { describe, expect, it, vi } from "vitest";
import { mediaAssetAuthorityDependenciesBatch } from "./media-asset-authority-dependencies";

function emptyDelegate() {
  return { findMany: vi.fn(async () => []) };
}

describe("mediaAssetAuthorityDependenciesBatch", () => {
  it("keeps dependency query count constant for the maximum 100 assets", async () => {
    const db = {
      $queryRaw: vi.fn(async () => []),
      character: emptyDelegate(),
      mediaAssetPlacement: emptyDelegate(),
      characterVisualProfile: emptyDelegate(),
      characterVisualReferenceSnapshot: emptyDelegate(),
      characterLook: emptyDelegate(),
      generationJob: emptyDelegate(),
      contentProductionItem: emptyDelegate(),
      characterServing: emptyDelegate(),
    };
    const assetIds = Array.from({ length: 100 }, (_, index) => `asset-${index}`);

    const dependencies = await mediaAssetAuthorityDependenciesBatch(
      db as never,
      assetIds,
    );

    expect(dependencies.size).toBe(100);
    expect([...dependencies.values()].every((items) => items.length === 0)).toBe(true);
    const querySpies = [
      db.character.findMany,
      db.mediaAssetPlacement.findMany,
      db.$queryRaw,
      db.characterVisualProfile.findMany,
      db.characterVisualReferenceSnapshot.findMany,
      db.characterLook.findMany,
      db.generationJob.findMany,
      db.contentProductionItem.findMany,
      db.characterServing.findMany,
    ];
    expect(querySpies).toHaveLength(9);
    for (const query of querySpies) {
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it("maps object and legacy raw-array Serving manifests without a release scan per asset", async () => {
    const characterServing = {
      findMany: vi.fn(async () => [
        {
          characterId: "character-object",
          state: "live",
          currentReleaseId: "release-object",
          scheduledReleaseId: null,
          currentRelease: {
            id: "release-object",
            releasePlacementManifest: {
              placements: [{ slotKey: "character_avatar", assetId: "asset-a" }],
            },
          },
          scheduledRelease: null,
        },
        {
          characterId: "character-legacy",
          state: "inactive",
          currentReleaseId: null,
          scheduledReleaseId: "release-legacy",
          currentRelease: null,
          scheduledRelease: {
            id: "release-legacy",
            releasePlacementManifest: [
              { placementId: "character_hero", assetId: "asset-b" },
            ],
          },
        },
      ]),
    };
    const db = {
      $queryRaw: vi.fn(async () => []),
      character: emptyDelegate(),
      mediaAssetPlacement: emptyDelegate(),
      characterVisualProfile: emptyDelegate(),
      characterVisualReferenceSnapshot: emptyDelegate(),
      characterLook: emptyDelegate(),
      generationJob: emptyDelegate(),
      contentProductionItem: emptyDelegate(),
      characterServing,
    };

    const dependencies = await mediaAssetAuthorityDependenciesBatch(
      db as never,
      ["asset-a", "asset-b"],
    );

    expect(dependencies.get("asset-a")).toContainEqual(expect.objectContaining({
      kind: "character_release",
      releaseId: "release-object",
      releaseState: "current",
      slot: "character_avatar",
    }));
    expect(dependencies.get("asset-b")).toContainEqual(expect.objectContaining({
      kind: "character_release",
      releaseId: "release-legacy",
      releaseState: "scheduled",
      slot: "character_hero",
    }));
    expect(characterServing.findMany).toHaveBeenCalledTimes(1);
  });

  it("maps a reference-only active Visual Profile as image authority", async () => {
    const characterVisualProfile = {
      findMany: vi.fn(async () => [{
        id: "profile-reference-only",
        characterId: "character-reference-only",
        anchorAssetIds: [],
        referenceAssetIds: ["asset-reference-only"],
      }]),
    };
    const db = {
      $queryRaw: vi.fn(async () => []),
      character: emptyDelegate(),
      mediaAssetPlacement: emptyDelegate(),
      characterVisualProfile,
      characterVisualReferenceSnapshot: emptyDelegate(),
      characterLook: emptyDelegate(),
      generationJob: emptyDelegate(),
      contentProductionItem: emptyDelegate(),
      characterServing: emptyDelegate(),
    };

    const dependencies = await mediaAssetAuthorityDependenciesBatch(
      db as never,
      ["asset-reference-only"],
    );

    expect(dependencies.get("asset-reference-only")).toContainEqual({
      kind: "character_visual_identity",
      characterId: "character-reference-only",
      visualProfileId: "profile-reference-only",
      repairPath: "/admin/characters/character-reference-only?tab=visual",
    });
    expect(characterVisualProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "active",
          character: { deletedAt: null },
          OR: expect.arrayContaining([
            { referenceAssetIds: { array_contains: ["asset-reference-only"] } },
          ]),
        }),
      }),
    );
  });
});
