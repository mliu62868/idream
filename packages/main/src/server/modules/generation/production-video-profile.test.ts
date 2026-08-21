import { describe, expect, it } from "vitest";
import {
  isProductionVideoProfile,
  isProductionLtxVideoProfile,
  productionVideoRecipeForProfile,
  PRODUCTION_H3_VIDEO_PROFILE,
  PRODUCTION_LTX_VIDEO_PROFILE,
} from "./production-video-profile";

function exactProfile() {
  return {
    ...PRODUCTION_LTX_VIDEO_PROFILE,
    mode: "video",
    convertedModelPath: null,
    enabled: true,
    status: "active",
  };
}

describe("production LTX video profile authority", () => {
  it("accepts the exact LTX 2.3 GTAnimation route", () => {
    expect(isProductionLtxVideoProfile(exactProfile())).toBe(true);
  });

  it.each([
    ["defaultHeight", 1024],
    ["allowedOrientations", ["9:16"]],
    ["requiredEntitlement", "premium_controls"],
    ["maxCount", 2],
    [
      "runnerConfig",
      {
        ...PRODUCTION_LTX_VIDEO_PROFILE.runnerConfig,
        capabilities: {
          ...PRODUCTION_LTX_VIDEO_PROFILE.runnerConfig.capabilities,
          fps: 24,
        },
      },
    ],
  ] as const)("rejects drift in %s", (key, value) => {
    expect(
      isProductionLtxVideoProfile({
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

  it("accepts the exact explicit MiniMax H3 route without changing the LTX default", () => {
    const profile = exactH3Profile();
    expect(isProductionVideoProfile(profile)).toBe(true);
    expect(isProductionLtxVideoProfile(profile)).toBe(false);
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
});
