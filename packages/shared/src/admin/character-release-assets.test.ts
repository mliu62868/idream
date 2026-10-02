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

function customerIdentityPlacement(
  slotKey: "character_avatar" | "character_hero" | "character_chat",
  overrides: Record<string, unknown> = {},
) {
  return {
    slotKey,
    assetId: `${slotKey}-customer-identity-asset`,
    slotVersion: 1,
    customerIdentityRevisionId: `${slotKey}-customer-identity-revision`,
    generationJobId: `${slotKey}-preview-job`,
    ...overrides,
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

  it("accepts directly adopted generation without a manual review decision", () => {
    const placements = [placement("character_avatar"), placement("character_hero"), placement("character_chat")]
      .map(({ reviewDecisionId: _historicalReview, ...generated }) => generated);
    expect(parseCharacterReleaseAssetManifest({ schemaVersion: 2, placements })?.placements).toEqual(placements);
  });

  it("accepts a customer-selected identity preview alongside production and uploaded assets", () => {
    const manifest = parseCharacterReleaseAssetManifest({
      schemaVersion: 2,
      placements: [
        {
          slotKey: "character_avatar",
          assetId: "customer-identity-asset",
          slotVersion: 1,
          customerIdentityRevisionId: " \u00a0customer-identity-revision\ufeff ",
          generationJobId: " \tpreview-job\n ",
        },
        placement("character_hero"),
        {
          slotKey: "character_chat",
          assetId: "uploaded-chat-asset",
          slotVersion: 1,
        },
      ],
    });

    expect(manifest).not.toBeNull();
    expect(characterReleaseAssetPlacement(manifest!, "character_avatar")).toEqual({
      slotKey: "character_avatar",
      assetId: "customer-identity-asset",
      slotVersion: 1,
      customerIdentityRevisionId: "customer-identity-revision",
      generationJobId: "preview-job",
    });
  });

  it.each([undefined, false])("accepts customer identity lineage with bootstrapIdentity=%s", (bootstrapIdentity) => {
    const placements = [
      customerIdentityPlacement("character_avatar", { bootstrapIdentity }),
      customerIdentityPlacement("character_hero"),
      customerIdentityPlacement("character_chat"),
    ];
    expect(parseCharacterReleaseAssetManifest({ schemaVersion: 2, placements })?.placements).toEqual(placements);
  });

  it("preserves production bootstrap and historical review lineage", () => {
    const placements = [
      { ...placement("character_avatar"), bootstrapIdentity: true },
      placement("character_hero"),
      placement("character_chat"),
    ];
    expect(parseCharacterReleaseAssetManifest({ schemaVersion: 2, placements })?.placements).toEqual(placements);
  });

  it.each([
    { label: "missing generation job", overrides: { generationJobId: undefined } },
    { label: "blank generation job", overrides: { generationJobId: " \t\ufeff\n " } },
    { label: "null generation job", overrides: { generationJobId: null } },
    { label: "non-string generation job", overrides: { generationJobId: 1 } },
    { label: "blank identity revision", overrides: { customerIdentityRevisionId: " \t\u00a0\ufeff\n " } },
    { label: "null identity revision", overrides: { customerIdentityRevisionId: null } },
    { label: "non-string identity revision", overrides: { customerIdentityRevisionId: 1 } },
    { label: "Creative Run", overrides: { runId: "run" } },
    { label: "Creative Item", overrides: { itemId: "item" } },
    { label: "complete Creative lineage", overrides: { runId: "run", itemId: "item" } },
    { label: "historical review decision", overrides: { reviewDecisionId: "decision" } },
    { label: "Creative bootstrap identity", overrides: { bootstrapIdentity: true } },
    { label: "non-boolean bootstrap flag", overrides: { bootstrapIdentity: "false" } },
    { label: "unknown placement key", overrides: { customerPreviewId: "preview" } },
  ])("rejects customer identity lineage with $label", ({ overrides }) => {
    expect(parseCharacterReleaseAssetManifest({
      schemaVersion: 2,
      placements: [
        customerIdentityPlacement("character_avatar", overrides),
        placement("character_hero"),
        placement("character_chat"),
      ],
    })).toBeNull();
  });

  it("rejects a standalone preview job without an identity receipt or Creative lineage", () => {
    expect(parseCharacterReleaseAssetManifest({
      schemaVersion: 2,
      placements: [
        { ...customerIdentityPlacement("character_avatar"), customerIdentityRevisionId: undefined },
        placement("character_hero"),
        placement("character_chat"),
      ],
    })).toBeNull();
  });

  it.each([
    {
      schemaVersion: 2,
      unexpected: "x",
      placements: [customerIdentityPlacement("character_avatar"), placement("character_hero"), placement("character_chat")],
    },
    {
      schemaVersion: 2,
      placements: [customerIdentityPlacement("character_avatar"), customerIdentityPlacement("character_avatar"), placement("character_chat")],
    },
    {
      schemaVersion: 2,
      placements: [customerIdentityPlacement("character_avatar"), placement("character_hero")],
    },
    {
      schemaVersion: 2,
      placements: [customerIdentityPlacement("character_avatar", { assetId: " character_hero-asset\n" }), placement("character_hero"), placement("character_chat")],
    },
  ])("keeps the exact manifest shape and three distinct normalized assets for customer identity", (manifest) => {
    expect(parseCharacterReleaseAssetManifest(manifest)).toBeNull();
  });

  it.each(["runId", "itemId", "generationJobId"] as const)(
    "rejects a generated placement missing %s instead of treating it as an import",
    (field) => {
      const partial: Record<string, unknown> = { ...placement("character_chat") };
      delete partial[field];
      expect(parseCharacterReleaseAssetManifest({
        schemaVersion: 2,
        placements: [placement("character_avatar"), placement("character_hero"), partial],
      })).toBeNull();
    },
  );

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
