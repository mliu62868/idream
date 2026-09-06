import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ profiles: vi.fn() }));
vi.mock("@/server/lib/db", () => ({ prisma: {
  featureFlag: { findUnique: async () => ({ enabled: true, rolloutPercent: 100 }) },
  generationModelProfile: { findMany: db.profiles },
  generationRecipe: { count: async () => 1 },
  pricingRule: { count: async () => 1 },
  character: { count: async () => 1 },
  $disconnect: async () => undefined,
} }));
vi.mock("@/server/modules/generation/generation-catalog", () => ({
  generationWorkflowDescriptor: async () => ({ version: "fixture-image-version" }),
}));
vi.mock("@/server/modules/ourdream/generation-profile-selection", () => ({
  filterPublicTextToImageGenerationProfiles: async (profiles: unknown[]) => profiles,
  generationProfileDeclaresTextToImage: () => true,
}));

import { runProbe } from "./probe-product-config";
import { PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE, PRODUCTION_H3_VIDEO_PROFILE } from "./modules/generation/production-video-profile";

function activeProfile(authority: typeof PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE | typeof PRODUCTION_H3_VIDEO_PROFILE) {
  return { ...authority, id: authority.profileKey, mode: "video", enabled: true,
    status: "active", convertedModelPath: null };
}

describe("product video readiness", () => {
  let videos: ReturnType<typeof activeProfile>[];
  beforeEach(() => {
    videos = [activeProfile(PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE)];
    db.profiles.mockImplementation(async ({ where }: { where: { mode: string } }) => where.mode === "video" ? videos : [{
      id: "image-profile", mode: "image", runner: "comfyui", workflowKey: "image-workflow", pipelineModel: "image-workflow",
    }]);
  });

  it("accepts the active default RedGraft route when the optional H3 route is disabled", async () => {
    const report = await runProbe();
    expect(report.ok).toBe(true);
    expect(report.activeVideoProfiles).toBe(1);
    expect(report.failureReasons).toEqual([]);
  });

  it("still rejects a missing default route even if an optional video recipe is active", async () => {
    videos = [activeProfile(PRODUCTION_H3_VIDEO_PROFILE)];
    const report = await runProbe();
    expect(report.ok).toBe(false);
    expect(report.failureReasons).toContain(`video_gen enabled without production video profiles: ${PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE.profileKey}`);
  });

  it("rejects execution drift in an exposed optional profile", async () => {
    const invalidProfile = activeProfile(PRODUCTION_H3_VIDEO_PROFILE);
    Object.assign(invalidProfile, { steps: -1 });
    videos.push(invalidProfile);
    const report = await runProbe();
    expect(report.ok).toBe(false);
    expect(report.invalidActiveVideoProfileIds).toEqual([PRODUCTION_H3_VIDEO_PROFILE.profileKey]);
  });
});
