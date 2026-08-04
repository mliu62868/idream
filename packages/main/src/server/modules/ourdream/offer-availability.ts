import { prisma } from "@/server/lib/db";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
import {
  featureFlagEnabled,
  hasCharacterGenerationRecipe,
  isExecutableGenerationProfile,
} from "./generation-profile-catalog";

export type PublicOfferAvailability = {
  readonly videoGeneration: boolean;
};

export async function publicOfferAvailability(): Promise<PublicOfferAvailability> {
  const now = new Date();
  const [videoEnabled, videoProfiles, videoRecipes, videoPricing] =
    await Promise.all([
      featureFlagEnabled("video_gen"),
      prisma.generationModelProfile.findMany({
        where: { mode: "video", status: "active", enabled: true },
      }),
      prisma.generationRecipe.findMany({
        where: { mode: "video", status: "active" },
        select: { useCase: true },
      }),
      prisma.pricingRule.findMany({
        where: {
          mode: "video",
          status: "active",
          OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }],
        },
        select: { id: true },
        take: 2,
      }),
    ]);

  return {
    videoGeneration:
      videoEnabled &&
      videoProfiles.some(
        (profile) =>
          isProductionLtxVideoProfile(profile) &&
          isExecutableGenerationProfile(profile),
      ) &&
      hasCharacterGenerationRecipe(videoRecipes) &&
      videoPricing.length === 1,
  };
}

export function publicFeatureProjection(
  value: unknown,
  availability: PublicOfferAvailability,
) {
  const features =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};

  if (!availability.videoGeneration) {
    if ("videoGeneration" in features) features.videoGeneration = false;
    if ("video_generation" in features) features.video_generation = false;
  }

  return features;
}
