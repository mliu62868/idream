import { describe, expect, it } from "vitest";
import {
  evaluateMediaAssetCustomerPublishability,
  isSyntheticMediaAsset,
} from "./media-asset-authority";

describe("media asset customer publishability", () => {
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
      jobProvider: "replicate",
      latestAttemptProvider: "replicate",
    })).toEqual({
      publishable: false,
      reasons: [
        "job_provider_untrusted",
        "latest_attempt_provider_untrusted",
        "pinned_job_provider_mismatch",
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
