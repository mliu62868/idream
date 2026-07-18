import { describe, expect, it } from "vitest";
import {
  evaluateMediaAssetCustomerPublishability,
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
  isSyntheticMediaAsset,
  resolveMediaAssetBlobLocator,
  SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
} from "./media-asset-authority";

describe("media asset customer publishability", () => {
  it("resolves owned storage and a versioned immutable duplicate locator", () => {
    expect(resolveMediaAssetBlobLocator({
      storageKey: "owner/source.webp",
      metadata: {},
    })).toEqual({
      kind: "owned_storage",
      key: "owner/source.webp",
    });
    expect(resolveMediaAssetBlobLocator({
      storageKey: null,
      metadata: {
        blobLocator: {
          schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
          kind: "shared_immutable",
          key: "owner/source.webp",
          sourceAssetId: "source-asset",
        },
        duplicateLineage: {
          sourceAssetId: "source-asset",
        },
      },
    })).toEqual({
      kind: "shared_immutable",
      key: "owner/source.webp",
      sourceAssetId: "source-asset",
    });
  });

  it("rejects generic provider keys and malformed or lineage-mismatched shared locators", () => {
    expect(resolveMediaAssetBlobLocator({
      storageKey: null,
      metadata: { providerKey: "not-canonical.webp" },
    })).toBeNull();
    expect(resolveMediaAssetBlobLocator({
      storageKey: null,
      metadata: {
        blobLocator: {
          schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
          kind: "shared_immutable",
          key: "owner/source.webp",
          sourceAssetId: "source-asset",
        },
        duplicateLineage: {
          sourceAssetId: "different-source",
        },
      },
    })).toBeNull();
  });

  it("requires a real hydratable locator rather than a relative UI URL or generic provider key", () => {
    expect(hasHydratableMediaBlobAuthority({
      storageKey: "owner/source.webp",
      url: "/user-content/source/content.webp",
    })).toBe(true);
    expect(hasHydratableMediaBlobAuthority({
      storageKey: null,
      url: "https://cdn.example.test/source.webp",
      metadata: {},
    })).toBe(true);
    expect(hasHydratableMediaBlobAuthority({
      storageKey: null,
      url: "/user-content/source/content.webp",
      metadata: { providerKey: "not-canonical.webp" },
    })).toBe(false);
    expect(hasHydratableMediaBlobAuthority({
      storageKey: null,
      url: "/user-content/duplicate/content.webp",
      metadata: {
        blobLocator: {
          schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
          kind: "shared_immutable",
          key: "owner/source.webp",
          sourceAssetId: "source-asset",
        },
        duplicateLineage: {
          sourceAssetId: "source-asset",
        },
      },
    })).toBe(true);
  });

  it("accepts non-synthetic assets with matching non-mock provider authority", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: {},
      pinnedProvider: "comfyui",
      jobProvider: "comfyui",
      latestAttemptProvider: "comfyui",
    })).toEqual({
      publishable: true,
      reasons: [],
    });
  });

  it("keeps legacy assets without provider lineage publishable", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: { synthetic: false },
    })).toEqual({
      publishable: true,
      reasons: [],
    });
  });

  it("rejects explicit synthetic metadata", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: { synthetic: true },
      pinnedProvider: "comfyui",
      jobProvider: "comfyui",
      latestAttemptProvider: "comfyui",
    })).toEqual({
      publishable: false,
      reasons: ["metadata_synthetic"],
    });
  });

  it("rejects a malformed synthetic marker instead of deferring failure to promotion", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: { synthetic: "true" },
      pinnedProvider: "comfyui",
      jobProvider: "comfyui",
      latestAttemptProvider: "comfyui",
    })).toEqual({
      publishable: false,
      reasons: ["metadata_synthetic_marker_invalid"],
    });
  });

  it.each([
    ["archived", "platform_asset_archived"],
    ["rejected", "platform_asset_rejected"],
  ] as const)("rejects Image Library assets marked %s", (status, reason) => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: {
        synthetic: false,
        platformAsset: { status },
      },
      pinnedProvider: "comfyui",
      jobProvider: "comfyui",
      latestAttemptProvider: "comfyui",
    })).toEqual({
      publishable: false,
      reasons: [reason],
    });
    expect(isMediaAssetOperationalForAuthority({
      platformAsset: { status },
    })).toBe(false);
  });

  it("keeps generated and approved Image Library states operational", () => {
    expect(isMediaAssetOperationalForAuthority({
      platformAsset: { status: "generated" },
    })).toBe(true);
    expect(isMediaAssetOperationalForAuthority({
      platformAsset: { status: "approved" },
    })).toBe(true);
  });

  it.each([
    { metadata: { synthetic: true }, expected: true },
    { metadata: { synthetic: "true" }, expected: true },
    { metadata: { synthetic: 1 }, expected: true },
    { metadata: { synthetic: "yes" }, expected: true },
    { metadata: { synthetic: false }, expected: false },
    { metadata: { synthetic: null }, expected: false },
    { metadata: {}, expected: false },
  ])("fails closed when classifying $metadata", ({ metadata, expected }) => {
    expect(isSyntheticMediaAsset(metadata)).toBe(expected);
  });

  it.each([
    {
      field: "pinnedProvider",
      reason: "pinned_provider_mock",
    },
    {
      field: "jobProvider",
      reason: "job_provider_mock",
    },
    {
      field: "latestAttemptProvider",
      reason: "latest_attempt_provider_mock",
    },
  ] as const)("rejects a mock-prefixed $field", ({ field, reason }) => {
    const providers = {
      pinnedProvider: "comfyui",
      jobProvider: "comfyui",
      latestAttemptProvider: "comfyui",
      [field]: "  Mock-image-local ",
    };
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: { synthetic: false },
      ...providers,
    })).toMatchObject({
      publishable: false,
      reasons: expect.arrayContaining([reason]),
    });
  });

  it("rejects pinned provider drift from the generation job", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: {},
      pinnedProvider: "comfyui",
      jobProvider: "pipeline",
      latestAttemptProvider: "pipeline",
    })).toEqual({
      publishable: false,
      reasons: ["pinned_job_provider_mismatch"],
    });
  });

  it("rejects arbitrary non-mock provider names that are not explicitly trusted", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: {},
      pinnedProvider: "looks-real-but-is-unclassified",
      jobProvider: "looks-real-but-is-unclassified",
      latestAttemptProvider: "looks-real-but-is-unclassified",
    })).toEqual({
      publishable: false,
      reasons: [
        "pinned_provider_untrusted",
        "job_provider_untrusted",
        "latest_attempt_provider_untrusted",
      ],
    });
  });

  it("fails closed when strict immutable provider evidence is missing or ambiguous", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: {},
      pinnedProviderRequired: true,
      pinnedProviderDuplicate: true,
      pinnedProviderAssetMismatch: true,
      jobProviderRequired: true,
      latestAttemptProviderRequired: true,
    })).toEqual({
      publishable: false,
      reasons: [
        "pinned_provider_missing",
        "pinned_provider_duplicate",
        "pinned_provider_asset_mismatch",
        "job_provider_missing",
        "latest_successful_attempt_provider_missing",
      ],
    });
  });

  it.each([
    {
      pinnedProvider: undefined,
      jobProvider: "comfyui",
    },
    {
      pinnedProvider: "comfyui",
      jobProvider: undefined,
    },
  ])("rejects one-sided pinned/job provider authority", (providers) => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: {},
      ...providers,
    })).toEqual({
      publishable: false,
      reasons: ["pinned_job_provider_mismatch"],
    });
  });

  it("reports every customer-publishability reason without hiding provenance drift", () => {
    expect(evaluateMediaAssetCustomerPublishability({
      metadata: { synthetic: true },
      pinnedProvider: "mock-pinned",
      jobProvider: "mock-job",
      latestAttemptProvider: "mock-attempt",
    })).toEqual({
      publishable: false,
      reasons: [
        "metadata_synthetic",
        "pinned_provider_mock",
        "job_provider_mock",
        "latest_attempt_provider_mock",
        "pinned_job_provider_mismatch",
      ],
    });
  });
});
