import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({
  entitlementMap: vi.fn(),
  generationCharacter: vi.fn(),
  dreamcoinBalance: vi.fn(),
  resolveGenerationPricingAuthority: vi.fn(),
  featureFlagEnabled: vi.fn(),
  generationWorkflowDescriptor: vi.fn(),
  resolveGenerationLook: vi.fn(),
  selectGenerationProfile: vi.fn(),
  selectRecipe: vi.fn(),
}));

vi.mock("./subscription-lifecycle", () => ({
  entitlementMap: authority.entitlementMap,
}));
vi.mock("./generation-profile-catalog", () => ({
  featureFlagEnabled: authority.featureFlagEnabled,
}));
vi.mock("@/server/modules/generation/generation-catalog", () => ({
  generationWorkflowDescriptor: authority.generationWorkflowDescriptor,
}));
vi.mock("./generation-character-authority", () => ({
  generationCharacter: authority.generationCharacter,
  resolveGenerationLook: authority.resolveGenerationLook,
  resolveGenerationVisualProfile: vi.fn(),
}));
vi.mock("./generation-profile-selection", () => ({
  assertGenerationProfileCanDispatchReferences: vi.fn(),
  generationReferenceRouteRequirements: vi.fn(),
  selectGenerationProfile: authority.selectGenerationProfile,
  selectRecipe: authority.selectRecipe,
}));

vi.mock("@/server/modules/billing/ledger", () => ({ dreamcoinBalance: authority.dreamcoinBalance }));
vi.mock("@/server/lib/generation-pricing", () => ({
  resolveGenerationPricingAuthority: authority.resolveGenerationPricingAuthority,
  generationCostFromAuthority: () => 10,
}));

import { quoteGeneration, resolveGenerationPlan } from "./generation-quote";
import { PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE, PRODUCTION_H3_VIDEO_PROFILE } from "@/server/modules/generation/production-video-profile";

const profile = {
  profileKey: "profile_image_premium_v1",
  version: 1,
  mode: "image",
  runner: "comfyui",
  pipelineModel: "redcraft-krea2-comfyui",
  workflowKey: "deleted-workflow",
  runnerConfig: { capabilities: { textToImage: true } },
  requiredEntitlement: "premium_models",
  allowedOrientations: ["1:1"],
  maxCount: 1,
  costMultiplier: 1.5,
};

const request = {
  mode: "image" as const,
  freeplay: true,
  consistencyMode: "balanced" as const,
  controls: { model: profile.profileKey },
  presetIds: [],
  outputCount: 1,
};

describe("generation quote workflow authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authority.entitlementMap.mockResolvedValue({
      premium_controls: true,
      premium_models: true,
    });
    authority.resolveGenerationLook.mockResolvedValue(null);
    authority.selectRecipe.mockResolvedValue({
      recipeKey: "template_image_freeplay_default",
      version: 1,
    });
    authority.selectGenerationProfile.mockResolvedValue(profile);
    authority.generationWorkflowDescriptor.mockResolvedValue(null);
  });

  it.each([
    { profile: PRODUCTION_REDGRAFT_LTX25_VIDEO_PROFILE, frames: 121, width: 768, height: 1152 },
    { profile: PRODUCTION_H3_VIDEO_PROFILE, frames: 124, width: 512, height: 512 },
  ])("quotes the exact result envelope of $profile.profileKey", async ({ profile: selected, frames, width, height }) => {
    authority.entitlementMap.mockResolvedValue({ premium_controls: true, video_generation: true });
    authority.featureFlagEnabled.mockResolvedValue(true);
    authority.generationCharacter.mockResolvedValue({ id: "character", imageAssetId: "source" });
    authority.selectGenerationProfile.mockResolvedValue({ ...selected, mode: "video", convertedModelPath: null, enabled: true, status: "active", costMultiplier: 1 });
    authority.generationWorkflowDescriptor.mockResolvedValue({ workflowKey: selected.workflowKey, version: selected.runnerConfig.workflowVersion });
    authority.dreamcoinBalance.mockResolvedValue(100);
    authority.resolveGenerationPricingAuthority.mockResolvedValue({ id: "video-price", ruleKey: "video", version: 1, baseCost: 10, effectiveFrom: null, updatedAt: new Date("2026-09-02T00:00:00Z") });
    const { quote } = await quoteGeneration({ userId: "user-1", body: {
      ...request, mode: "video", freeplay: false, characterId: "character", controls: { model: selected.profileKey },
    }, profileSelectionAuthority: "public_generator" });
    expect(quote).toMatchObject({ profileId: selected.profileKey, profileVersion: selected.version,
      video: { durationSeconds: frames / 24, width, height, audio: "generated" } });
    expect(quote.orientations).toEqual(selected.allowedOrientations);
  });

  it("rejects a ComfyUI plan before quote authority when its descriptor is missing", async () => {
    await expect(
      resolveGenerationPlan("user-1", request),
    ).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
      details: {
        reason: "workflow_descriptor_missing",
        profileKey: profile.profileKey,
        profileVersion: profile.version,
        workflowKey: profile.workflowKey,
      },
    });
  });

  it("allows a descriptor-less remote pipeline profile", async () => {
    authority.selectGenerationProfile.mockResolvedValue({
      ...profile,
      runner: "pipeline",
      pipelineModel: "remote-image-provider",
      workflowKey: null,
    });

    await expect(resolveGenerationPlan("user-1", request)).resolves.toMatchObject({
      workflowDescriptor: null,
      profile: { runner: "pipeline" },
    });
  });
});
