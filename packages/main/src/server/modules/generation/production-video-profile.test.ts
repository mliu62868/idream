import { describe, expect, it } from "vitest";
import {
  isProductionLtxVideoProfile,
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
