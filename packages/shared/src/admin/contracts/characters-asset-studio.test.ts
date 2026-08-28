import { describe, expect, it } from "vitest";
import {
  characterDraftImageSelectionRequestSchema,
  characterDraftImageSelectionResultSchema,
} from "./characters-asset-studio";

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
});
