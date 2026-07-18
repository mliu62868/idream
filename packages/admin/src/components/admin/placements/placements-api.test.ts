import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREATE_STATUSES,
  PATCH_ACTIONS,
  placementCreatePayload,
  placementPatchPayload,
  publishableApprovedAssets,
  type PlacementDraft,
} from "./placements-api";

const baseDraft: PlacementDraft = {
  mediaAssetId: "asset-1",
  slot: "feed_card",
  targetType: "character",
  targetId: "char-1",
  status: "draft",
  reason: " because reasons ",
};

describe("placementCreatePayload", () => {
  it("carries every create field verbatim and trims reason", () => {
    expect(placementCreatePayload(baseDraft)).toEqual({
      mediaAssetId: "asset-1",
      slot: "feed_card",
      targetType: "character",
      targetId: "char-1",
      status: "draft",
      reason: "because reasons",
    });
  });

  it("does not fall back or drop fields for other slot and target combinations", () => {
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

  it("keeps legacy create draft-only and patch non-publishing", () => {
    expect(CREATE_STATUSES).toEqual(["draft"]);
    expect(PATCH_ACTIONS).toEqual(["paused", "archived"]);
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

  it("works for each non-publishing legacy patch action", () => {
    expect(placementPatchPayload("p1", "paused", "pause")).toEqual({
      status: "paused",
      reason: "pause",
      confirmation: "p1",
    });
    expect(placementPatchPayload("p1", "archived", "done")).toEqual({
      status: "archived",
      reason: "done",
      confirmation: "p1",
    });
  });
});

describe("publishableApprovedAssets", () => {
  it("keeps impossible backend choices out of the Placement selector", () => {
    expect(publishableApprovedAssets([
      {
        id: "trusted",
        purpose: "feed",
        targetId: "home",
        customerPublishable: true,
        publishabilityReasons: [],
      },
      {
        id: "missing-authority",
        purpose: "feed",
        targetId: "home",
        customerPublishable: false,
        publishabilityReasons: ["job_provider_missing"],
      },
    ]).map((asset) => asset.id)).toEqual(["trusted"]);
  });

  it("wires publishability, idempotency, and committed-refresh truth into the UI", () => {
    const createSource = readFileSync(
      new URL("./PlacementsNewPage.tsx", import.meta.url),
      "utf8",
    );
    const detailSource = readFileSync(
      new URL("./PlacementsDetailPage.tsx", import.meta.url),
      "utf8",
    );

    expect(createSource).toContain("publishableApprovedAssets(data.items)");
    expect(createSource).toContain('"idempotency-key": idempotencyKey');
    expect(detailSource).toContain('"idempotency-key": idempotencyKey');
    expect(detailSource).toContain('"if-match": `"${row.version}"`');
    expect(createSource).toContain("generation authority is incomplete or untrusted");
    expect(detailSource).toContain("Placement pause was committed, but the latest projection could not be refreshed");
    expect(detailSource).toContain("Placement archival was committed, but the latest projection could not be refreshed");
    expect(detailSource).toContain("await reload(true)");
    expect(detailSource).toContain('row.status !== "archived"');
    expect(detailSource).toContain('!["paused", "archived"].includes(row.status)');
  });
});
