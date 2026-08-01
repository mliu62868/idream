import { describe, expect, it } from "vitest";
import {
  generationDispatchModelKey,
  unavailablePinnedManifestReferenceRoles,
} from "./attempt-dispatch";

describe("Generation dispatch model authority", () => {
  it("routes a pinned profile through its workflow key instead of its legacy pipeline model", () => {
    expect(generationDispatchModelKey({
      mode: "image",
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      model: "redcraft-krea2-redmix3-bf16",
      profileId: "redcraft-krea2-redmix3-comparison",
    })).toBe("redcraft-krea2-redmix3-txt2img");
  });

  it("keeps the existing fallback order when no workflow is pinned", () => {
    expect(generationDispatchModelKey({
      mode: "video",
      workflowKey: null,
      model: null,
      profileId: null,
    })).toBe("unresolved-video-model");
  });
});

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
