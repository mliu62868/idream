import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({
  entitlementMap: vi.fn(),
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
  generationCharacter: vi.fn(),
  publishedGenerationVideoCharacter: vi.fn(),
  resolveGenerationLook: authority.resolveGenerationLook,
  resolveGenerationVisualProfile: vi.fn(),
}));
vi.mock("./generation-profile-selection", () => ({
  assertGenerationProfileCanDispatchReferences: vi.fn(),
  generationReferenceRouteRequirements: vi.fn(),
  selectGenerationProfile: authority.selectGenerationProfile,
  selectRecipe: authority.selectRecipe,
}));

import { resolveGenerationPlan } from "./generation-quote";

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
