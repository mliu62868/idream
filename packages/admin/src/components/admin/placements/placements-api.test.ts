import { describe, expect, it } from "vitest";
import { placementCreatePayload, placementPatchPayload, type PlacementDraft } from "./placements-api";

const baseDraft: PlacementDraft = {
  mediaAssetId: "asset-1",
  slot: "feed_card",
  targetType: "character",
  targetId: "char-1",
  status: "published",
  reason: " because reasons ",
};

describe("placementCreatePayload", () => {
  it("carries every create field verbatim and trims reason", () => {
    expect(placementCreatePayload(baseDraft)).toEqual({
      mediaAssetId: "asset-1",
      slot: "feed_card",
      targetType: "character",
      targetId: "char-1",
      status: "published",
      reason: "because reasons",
    });
  });

  it("does not fall back or drop fields for other slot/targetType/status combinations", () => {
    expect(
      placementCreatePayload({
        ...baseDraft,
        slot: "campaign",
        targetType: "campaign",
        status: "draft",
      }),
    ).toEqual({
      mediaAssetId: "asset-1",
      slot: "campaign",
      targetType: "campaign",
      targetId: "char-1",
      status: "draft",
      reason: "because reasons",
    });
  });
});

describe("placementPatchPayload", () => {
  it("auto-fills confirmation from the placement id (not user-typed) and carries the reason", () => {
    expect(placementPatchPayload("placement-9", "paused", "pausing for review")).toEqual({
      status: "paused",
      reason: "pausing for review",
      confirmation: "placement-9",
    });
  });

  it("works for each patch action", () => {
    expect(placementPatchPayload("p1", "published", "go live")).toEqual({
      status: "published",
      reason: "go live",
      confirmation: "p1",
    });
    expect(placementPatchPayload("p1", "archived", "done")).toEqual({
      status: "archived",
      reason: "done",
      confirmation: "p1",
    });
  });
});
