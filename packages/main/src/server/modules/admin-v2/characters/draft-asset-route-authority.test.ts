import { describe, expect, it } from "vitest";
import { evaluateDraftAssetRouteAuthority } from "./draft-asset-route-authority";

describe("Character draft placement authority", () => {
  it("keeps existing library selections valid when the generation route changes", () => {
    const result = evaluateDraftAssetRouteAuthority(
      {
        character_cover: {
          assetId: "cover",
          generationRouteFingerprint: "old-route",
        },
        character_hero: { assetId: "hero" },
        character_chat: { assetId: "chat" },
      },
      "new-route",
    );

    expect(result).toMatchObject({
      status: "current",
      stalePurposes: [],
      missingPurposes: [],
      releaseReady: true,
      releaseBlockers: [],
    });
  });

  it("still blocks an incomplete three-placement pack", () => {
    const result = evaluateDraftAssetRouteAuthority(
      {
        character_cover: { assetId: "cover" },
      },
      null,
    );

    expect(result.releaseReady).toBe(false);
    expect(result.missingPurposes).toEqual([
      "character_hero",
      "character_chat",
    ]);
    expect(result.releaseBlockers).toEqual(["draft_asset_pack_incomplete"]);
  });
});
