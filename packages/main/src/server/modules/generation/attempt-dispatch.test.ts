import { describe, expect, it } from "vitest";
import { unavailablePinnedManifestReferenceRoles } from "./attempt-dispatch";

describe("Generation dispatch manifest role authority", () => {
  const overlappingManifest = [
    { mediaAssetId: "shared-asset", role: "primary_face" },
    { mediaAssetId: "shared-asset", role: "source_image" },
  ];

  it("detects a silent downgrade when one asset survives but one of its roles is lost", () => {
    expect(unavailablePinnedManifestReferenceRoles({
      referenceManifest: overlappingManifest,
      referenceImages: [{
        assetId: "shared-asset",
        role: "source_image",
      }],
    })).toEqual([{
      assetId: "shared-asset",
      role: "primary_face",
    }]);
  });

  it("accepts the same asset only when both canonical and source roles survive dispatch", () => {
    expect(unavailablePinnedManifestReferenceRoles({
      referenceManifest: overlappingManifest,
      referenceImages: [{
        assetId: "shared-asset",
        role: "identity_anchor",
      }, {
        assetId: "shared-asset",
        role: "source_image",
      }],
    })).toEqual([]);
  });
});
