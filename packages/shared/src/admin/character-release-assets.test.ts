import { describe, expect, it } from "vitest";
import {
  characterReleaseAssetPlacement,
  parseCharacterReleaseAssetManifest,
} from "./character-release-assets";

function placement(
  slotKey: "character_avatar" | "character_hero" | "character_chat",
) {
  return {
    slotKey,
    assetId: `${slotKey}-asset`,
    slotVersion: 1,
    runId: `${slotKey}-run`,
    itemId: `${slotKey}-item`,
    reviewDecisionId: `${slotKey}-decision`,
    generationJobId: `${slotKey}-job`,
  };
}

describe("Character Release asset manifest", () => {
  it("parses one exact, fully traced placement per customer surface", () => {
    const manifest = parseCharacterReleaseAssetManifest({
      schemaVersion: 2,
      placements: [
        placement("character_avatar"),
        placement("character_hero"),
        placement("character_chat"),
      ],
    });

    expect(manifest).not.toBeNull();
    expect(characterReleaseAssetPlacement(manifest!, "character_hero")).toMatchObject({
      assetId: "character_hero-asset",
      generationJobId: "character_hero-job",
    });
  });

  it("accepts imported library images without synthetic generation lineage", () => {
    const imported = (slotKey: "character_avatar" | "character_hero" | "character_chat") => ({
      slotKey,
      assetId: `${slotKey}-imported-asset`,
      slotVersion: 1,
    });

    expect(parseCharacterReleaseAssetManifest({
      schemaVersion: 2,
      placements: [
        imported("character_avatar"),
        imported("character_hero"),
        imported("character_chat"),
      ],
    })).not.toBeNull();
  });

  it.each([
    {
      schemaVersion: 1,
      placements: [
        placement("character_avatar"),
        placement("character_hero"),
        placement("character_chat"),
      ],
    },
    {
      schemaVersion: 2,
      placements: [
        placement("character_avatar"),
        placement("character_avatar"),
        placement("character_chat"),
      ],
    },
    {
      schemaVersion: 2,
      placements: [
        placement("character_avatar"),
        placement("character_hero"),
      ],
    },
    {
      schemaVersion: 2,
      placements: [
        placement("character_avatar"),
        placement("character_hero"),
        {
          ...placement("character_chat"),
          undeclared: true,
        },
      ],
    },
    {
      schemaVersion: 2,
      placements: [
        placement("character_avatar"),
        {
          ...placement("character_hero"),
          assetId: "character_avatar-asset",
        },
        placement("character_chat"),
      ],
    },
  ])("fails closed for malformed or incomplete manifests", (manifest) => {
    expect(parseCharacterReleaseAssetManifest(manifest)).toBeNull();
  });
});
