import { describe, expect, it } from "vitest";
import {
  isDefaultProductionVideoProfile,
  isProductionVideoProfile,
  productionVideoRecipeForProfile,
  PRODUCTION_DEFAULT_VIDEO_PROFILE,
  PRODUCTION_H3_VIDEO_PROFILE,
  PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE,
} from "./production-video-profile";

function exactProfile() {
  return {
    ...PRODUCTION_DEFAULT_VIDEO_PROFILE,
    mode: "video",
    convertedModelPath: null,
    enabled: true,
    status: "active",
  };
}

describe("default production video profile authority", () => {
  it("accepts the exact RedGraft LTX 2.5 route", () => {
    expect(isDefaultProductionVideoProfile(exactProfile())).toBe(true);
  });

  it.each([
    ["defaultHeight", 1024],
    ["allowedOrientations", ["9:16"]],
    ["requiredEntitlement", "premium_controls"],
    ["maxCount", 2],
    [
      "runnerConfig",
      {
        ...PRODUCTION_DEFAULT_VIDEO_PROFILE.runnerConfig,
        capabilities: {
          ...PRODUCTION_DEFAULT_VIDEO_PROFILE.runnerConfig.capabilities,
          fps: 25,
        },
      },
    ],
  ] as const)("rejects drift in %s", (key, value) => {
    expect(
      isDefaultProductionVideoProfile({
        ...exactProfile(),
        [key]: value,
      }),
    ).toBe(false);
  });
});

describe("production video profile catalog", () => {
  function exactH3Profile() {
    return {
      ...PRODUCTION_H3_VIDEO_PROFILE,
      mode: "video",
      convertedModelPath: null,
      enabled: true,
      status: "active",
    };
  }

  function exactRedGraftProfile() {
    return {
      ...PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE,
      mode: "video",
      convertedModelPath: null,
      enabled: true,
      status: "active",
    };
  }

  it("accepts the exact explicit MiniMax H3 route without changing the RedGraft default", () => {
    const profile = exactH3Profile();
    expect(isProductionVideoProfile(profile)).toBe(true);
    expect(isDefaultProductionVideoProfile(profile)).toBe(false);
    expect(productionVideoRecipeForProfile(profile)).toMatchObject({
      workflowKey: "minimax-h3-redcraft-i2v",
      durationSeconds: 5,
      frameCount: 124,
      explicitSelectionOnly: true,
    });
  });

  it("rejects drift in the H3 frame-rate authority", () => {
    const profile = exactH3Profile();
    expect(isProductionVideoProfile({
      ...profile,
      runnerConfig: {
        ...profile.runnerConfig,
        capabilities: {
          ...profile.runnerConfig.capabilities,
          fps: 25,
        },
      },
    })).toBe(false);
  });

  it("accepts RedGraft LTX 2.5 as the default route", () => {
    const profile = exactRedGraftProfile();
    expect(isProductionVideoProfile(profile)).toBe(true);
    expect(isDefaultProductionVideoProfile(profile)).toBe(true);
    expect(productionVideoRecipeForProfile(profile)).toMatchObject({
      workflowKey: "redgraft-ltx25-i2v",
      durationSeconds: 5,
      frameCount: 121,
      fps: 24,
      explicitSelectionOnly: false,
    });
  });
});
