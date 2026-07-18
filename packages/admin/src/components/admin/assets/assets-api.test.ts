import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSETS_BULK,
  ASSETS_BULK_PREFLIGHT,
  AssetBulkArchiveError,
  assetAuthorityDependencyView,
  assetBulkArchivePayload,
  assetPatchPayload,
  assetsListPath,
  bulkArchiveAssets,
  canonicalAssetIds,
  draftFromAsset,
  preflightArchiveAssets,
  splitTags,
  type AssetAuthorityDependency,
  type ContentAsset,
} from "./assets-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assetsListPath", () => {
  it("returns the bare endpoint when no filters (or 'all') are given", () => {
    expect(assetsListPath()).toBe("/api/v1/admin/content/assets");
    expect(assetsListPath({ status: "all", purpose: "all" })).toBe("/api/v1/admin/content/assets");
  });

  it("appends status and purpose as query params", () => {
    expect(assetsListPath({ status: "approved" })).toBe("/api/v1/admin/content/assets?status=approved");
    expect(assetsListPath({ status: "approved", purpose: "feed" })).toBe(
      "/api/v1/admin/content/assets?status=approved&purpose=feed",
    );
  });
});

describe("splitTags", () => {
  it("trims and drops blank entries", () => {
    expect(splitTags(" neon ,  , city, ")).toEqual(["neon", "city"]);
  });

  it("returns an empty array for a blank string", () => {
    expect(splitTags("   ")).toEqual([]);
  });
});

describe("draftFromAsset", () => {
  it("joins tags and falls back to an empty description", () => {
    const asset = { tags: ["neon", "city"], description: null } as ContentAsset;
    expect(draftFromAsset(asset)).toEqual({ tags: "neon, city", description: "" });
  });
});

describe("assetAuthorityDependencyView", () => {
  it("names every backend authority kind without falling through to Campaign", () => {
    const dependencies: AssetAuthorityDependency[] = [
      {
        kind: "character_primary_image",
        characterId: "character-1",
        repairPath: "/character",
      },
      {
        kind: "character_project_draft",
        characterId: "character-1",
        projectId: "project-1",
        repairPath: "/project",
      },
      {
        kind: "character_visual_identity",
        characterId: "character-1",
        visualProfileId: "profile-1",
        repairPath: "/visual",
      },
      {
        kind: "character_reference_set",
        characterId: "character-1",
        visualProfileId: "profile-1",
        referenceSetRevisionId: "reference-set-1",
        repairPath: "/references",
      },
      {
        kind: "character_generation_job",
        characterId: "character-1",
        generationJobId: "job-1",
        runId: "run-1",
        repairPath: "/job",
      },
      {
        kind: "character_look",
        characterId: "character-1",
        lookId: "look-1",
        status: "active",
        repairPath: "/look",
      },
      {
        kind: "creative_run_asset",
        characterId: "character-1",
        itemId: "item-1",
        runId: "run-1",
        status: "generated",
        repairPath: "/run",
      },
      {
        kind: "character_release",
        characterId: "character-1",
        releaseId: "release-1",
        releaseState: "scheduled",
        slot: "hero",
        repairPath: "/release",
      },
      {
        kind: "verified_campaign",
        placementId: "placement-1",
        runId: "run-1",
        targetId: "campaign-1",
        repairPath: "/campaign",
      },
      {
        kind: "placement_verification",
        placementId: "placement-2",
        runId: "run-1",
        targetId: "campaign-2",
        repairPath: "/placement",
      },
    ];

    expect(dependencies.map(assetAuthorityDependencyView)).toEqual([
      expect.objectContaining({ title: "Character primary image", detail: "character-1" }),
      expect.objectContaining({ title: "Character project draft", detail: "character-1 · project-1" }),
      expect.objectContaining({ title: "Active visual identity", detail: "character-1 · profile-1" }),
      expect.objectContaining({ title: "Published character reference set", detail: "character-1 · reference-set-1" }),
      expect.objectContaining({ title: "Active character generation job", detail: "character-1 · job-1" }),
      expect.objectContaining({ title: "Active character look", detail: "active · character-1 · look-1" }),
      expect.objectContaining({ title: "Creative Run asset in use", detail: "generated · run-1 · item-1" }),
      expect.objectContaining({ title: "Scheduled Character Release", detail: "hero · release-1" }),
      expect.objectContaining({ title: "Verified live campaign", detail: "campaign-1 · placement-1" }),
      expect.objectContaining({ title: "Campaign verification in progress", detail: "campaign-2 · placement-2" }),
    ]);
  });
});

describe("assetPatchPayload", () => {
  it("only exposes the Library archive state mutation and trims blank description", () => {
    expect(
      assetPatchPayload({
        id: "asset-123",
        draft: { tags: "neon, city", description: "  " },
        reason: "Archive unused asset",
        status: "archived",
      }),
    ).toEqual({
      status: "archived",
      reason: "Archive unused asset",
      confirmation: "asset-123",
    });
  });

  it("omits status when not provided (metadata-only save)", () => {
    expect(
      assetPatchPayload({
        id: "asset-123",
        draft: { tags: "", description: "Chat reuse note" },
        reason: "Updated search metadata",
      }),
    ).toEqual({
      status: undefined,
      tags: [],
      description: "Chat reuse note",
      reason: "Updated search metadata",
      confirmation: "asset-123",
    });
  });
});

describe("bulk asset archival", () => {
  it("canonicalizes the exact target list before building the confirmation", () => {
    expect(canonicalAssetIds([" asset-b ", "asset-a", "asset-b", ""])).toEqual([
      "asset-a",
      "asset-b",
    ]);
    expect(assetBulkArchivePayload({
      assetIds: ["asset-b", "asset-a", "asset-b"],
      reason: "  retire unused set  ",
    })).toEqual({
      assetIds: ["asset-a", "asset-b"],
      status: "archived",
      reason: "retire unused set",
      confirmation: "asset-a,asset-b",
    });
  });

  it("sends one atomic POST with exact IDs and returns every updated target", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        data: { updatedIds: ["asset-a", "asset-b"] },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(bulkArchiveAssets({
      assetIds: ["asset-b", "asset-a"],
      reason: "Archive unused set",
    })).resolves.toEqual({ updatedIds: ["asset-a", "asset-b"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(ASSETS_BULK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetIds: ["asset-a", "asset-b"],
        status: "archived",
        reason: "Archive unused set",
        confirmation: "asset-a,asset-b",
      }),
    });
  });

  it("preflights every canonical target in one POST and preserves exact blocker IDs", async () => {
    const dependency: AssetAuthorityDependency = {
      kind: "character_primary_image",
      characterId: "character-1",
      repairPath: "/admin/characters/character-1?tab=assets",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          assetIds: ["asset-a", "asset-b"],
          blockers: [{ assetId: "asset-b", dependencies: [dependency] }],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      preflightArchiveAssets(["asset-b", "asset-a", "asset-b"]),
    ).resolves.toEqual({
      assetIds: ["asset-a", "asset-b"],
      blockers: [{ assetId: "asset-b", dependencies: [dependency] }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(ASSETS_BULK_PREFLIGHT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetIds: ["asset-a", "asset-b"] }),
    });
  });

  it("preserves structured authority dependencies for repair links", async () => {
    const dependency: AssetAuthorityDependency = {
      kind: "character_release",
      characterId: "character-1",
      releaseId: "release-1",
      releaseState: "current",
      slot: "portrait",
      repairPath: "/admin/characters/character-1?tab=release",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        ok: false,
        error: {
          message: "Asset remains in use",
          details: {
            code: "asset_authority_dependency_active",
            dependencies: [dependency],
            repairPath: dependency.repairPath,
          },
        },
      }),
    }));

    const error = await bulkArchiveAssets({
      assetIds: ["asset-a"],
      reason: "Archive stale image",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AssetBulkArchiveError);
    expect(error).toMatchObject({
      message: "Asset remains in use",
      details: {
        code: "asset_authority_dependency_active",
        dependencies: [dependency],
        missingAssetIds: [],
        repairPath: dependency.repairPath,
      },
    });
  });
});
