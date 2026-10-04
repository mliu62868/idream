import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE } from "@/server/modules/generation/production-video-profile";
import { publicFeatureProjection, publicOfferAvailability } from "./offer-availability";

const state = vi.hoisted(() => ({ videoProfiles: [] as unknown[] }));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    featureFlag: { findUnique: async () => ({ enabled: true, rolloutPercent: 100 }) },
    generationModelProfile: { findMany: async () => state.videoProfiles },
    generationRecipe: { findMany: async () => [{ useCase: "character" }] },
    pricingRule: { findMany: async () => [{ id: "video-price" }] },
  },
}));

const activeOptionsProfile = {
  ...PRODUCTION_REDGRAFT_LTX25_VIDEO_OPTIONS_PROFILE,
  mode: "video",
  convertedModelPath: null,
  enabled: true,
  status: "active",
};

describe("public offer video availability", () => {
  beforeEach(() => {
    state.videoProfiles = [];
  });

  // Regression: /plans and /me projected Deluxe video to false while Generate
  // served the v7 options publication. Both must read the same recipe catalog.
  it("advertises video when the only active route is the v7 options publication", async () => {
    state.videoProfiles = [activeOptionsProfile];
    const availability = await publicOfferAvailability();
    expect(availability.videoGeneration).toBe(true);
    expect(publicFeatureProjection({ videoGeneration: true }, availability)).toEqual({ videoGeneration: true });
  });

  it("hides video when no active profile is an authorized production recipe", async () => {
    state.videoProfiles = [{ ...activeOptionsProfile, version: 5 }];
    const availability = await publicOfferAvailability();
    expect(availability.videoGeneration).toBe(false);
    expect(publicFeatureProjection({ video_generation: true }, availability)).toEqual({ video_generation: false });
  });
});
