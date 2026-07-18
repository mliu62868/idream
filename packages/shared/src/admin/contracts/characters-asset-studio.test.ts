import { describe, expect, it } from "vitest";
import {
  characterDraftImageSelectionRequestSchema,
  characterDraftImageSelectionResultSchema,
} from "./characters";

describe("Character Asset Studio contracts", () => {
  it("requires the exact reviewed Run item and optimistic Project version", () => {
    const request = {
      entityVersion: 4,
      purpose: "character_hero" as const,
      runId: "run-1",
      itemId: "item-1",
      assetId: "asset-1",
      reviewDecisionId: "decision-1",
      reason: "Use the approved identity-consistent portrait in the next Release",
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
