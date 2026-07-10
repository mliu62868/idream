import { describe, expect, it } from "vitest";
import { assetPatchPayload, assetsListPath, draftFromAsset, splitTags, type ContentAsset } from "./assets-api";

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

describe("assetPatchPayload", () => {
  it("includes status when provided and trims a blank description to undefined", () => {
    expect(
      assetPatchPayload({
        id: "asset-123",
        draft: { tags: "neon, city", description: "  " },
        reason: "Approved from review",
        status: "approved",
      }),
    ).toEqual({
      status: "approved",
      tags: ["neon", "city"],
      description: undefined,
      reason: "Approved from review",
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
