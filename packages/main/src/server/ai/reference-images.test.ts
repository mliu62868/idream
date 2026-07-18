import { describe, expect, it, vi } from "vitest";
import {
  generationReferenceRequests,
  hydratedImageReferenceInputs,
} from "./reference-images";

describe("image reference hydration authority", () => {
  it("preserves canonical and source roles when both point at the same asset", () => {
    expect(generationReferenceRequests({
      anchorAssetIds: ["shared-asset"],
      identityReferenceIds: ["shared-asset"],
      jobReferenceIds: ["shared-asset", "shared-asset"],
      referenceManifest: [
        { mediaAssetId: "shared-asset", role: "primary_face", weight: 1.25 },
        { mediaAssetId: "shared-asset", role: "source_image", weight: 0.9 },
      ],
      maxReferences: 2,
    })).toEqual([
      expect.objectContaining({
        mediaAssetId: "shared-asset",
        role: "identity_anchor",
        weight: 1.25,
      }),
      expect.objectContaining({
        mediaAssetId: "shared-asset",
        role: "source_image",
        weight: 0.9,
      }),
    ]);
  });

  it("adds an explicit source role without replacing an overlapping canonical manifest role", () => {
    expect(generationReferenceRequests({
      sourceImageAssetId: "shared-asset",
      anchorAssetIds: ["shared-asset"],
      identityReferenceIds: [],
      jobReferenceIds: ["shared-asset"],
      referenceManifest: [
        { mediaAssetId: "shared-asset", role: "primary_face" },
      ],
      maxReferences: 2,
    }).map((reference) => reference.role)).toEqual([
      "source_image",
      "identity_anchor",
    ]);
  });

  it("keeps canonical identity and Look tuples when both roles use the same asset", () => {
    expect(generationReferenceRequests({
      lookReferenceAssetId: "shared-asset",
      anchorAssetIds: ["shared-asset"],
      identityReferenceIds: [],
      jobReferenceIds: ["shared-asset"],
      referenceManifest: [
        {
          mediaAssetId: "shared-asset",
          role: "primary_face",
          selectionReason: "canonical_identity_anchor",
        },
      ],
      maxReferences: 2,
    })).toEqual([
      expect.objectContaining({
        mediaAssetId: "shared-asset",
        role: "look_reference",
      }),
      expect.objectContaining({
        mediaAssetId: "shared-asset",
        role: "identity_anchor",
        selectionReason: "canonical_identity_anchor",
      }),
    ]);
  });

  it("fails closed when one pinned reference cannot become provider-readable", async () => {
    const signGetUrl = vi.fn(async (input: {
      key: string;
      expiresInSeconds: number;
    }) =>
      input.key === "identity/unavailable.webp"
        ? {
            ok: false as const,
            error: {
              code: "not_found",
              message: "reference object missing",
              retryable: false,
            },
          }
        : {
            ok: true as const,
            data: {
              url: `https://blob.test/${encodeURIComponent(input.key)}`,
            },
          }
    );

    await expect(
      hydratedImageReferenceInputs(
        [
          {
            assetId: "anchor-unavailable",
            role: "identity_anchor",
            storageKey: "identity/unavailable.webp",
          },
          {
            assetId: "anchor-available",
            role: "identity_reference",
            storageKey: "identity/available.webp",
          },
        ],
        { signGetUrl },
      ),
    ).rejects.toThrow(
      "Pinned image references could not be hydrated: anchor-unavailable",
    );
  });
});
