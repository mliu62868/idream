import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const catalog = vi.hoisted(() => ({
  generationWorkflowDescriptor: vi.fn(),
}));

vi.mock("@/server/modules/generation/generation-catalog", () => ({
  generationWorkflowDescriptor: catalog.generationWorkflowDescriptor,
}));

import {
  filterPublicTextToImageGenerationProfiles,
  filterPublicCharacterImageGenerationProfiles,
  generationProfileDeclaresTextToImage,
  projectPublicImageEditGenerationProfiles,
} from "./generation-profile-selection";

const profile = {
  mode: "image",
  runner: "comfyui",
  runnerConfig: {
    capabilities: { textToImage: true },
  },
  workflowKey: "deleted-workflow",
  pipelineModel: "deleted-workflow",
  allowedOrientations: ["1:1"],
  maxCount: 1,
  rolloutPercent: 100,
};

describe("public text-to-image generation profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed when the configured workflow descriptor is missing", async () => {
    catalog.generationWorkflowDescriptor.mockResolvedValue(null);

    await expect(
      filterPublicTextToImageGenerationProfiles([profile]),
    ).resolves.toEqual([]);
  });

  it("exposes a profile only when its workflow is executable as text-to-image", async () => {
    catalog.generationWorkflowDescriptor.mockResolvedValue({
      capabilities: ["textToImage"],
      inputs: [{ type: "text" }],
    });

    await expect(
      filterPublicTextToImageGenerationProfiles([profile]),
    ).resolves.toEqual([profile]);
  });

  // SPEC: a profile with no workflow descriptor is not a public route.
  // INTENT: this used to assert the opposite for a non-comfyui runner, because
  // the legacy OpenAI-compatible gateway took a bare model name and had no
  // workflow to describe. That adapter and its runner values retired on
  // 2026-09-12; with `comfyui` the only runner left, a descriptor-less profile
  // names something no backend can execute, so offering it would be a promise
  // the generator cannot keep.
  it("drops descriptor-less profiles even when they declare text-to-image", async () => {
    catalog.generationWorkflowDescriptor.mockResolvedValue(null);
    const descriptorless = {
      ...profile,
      runner: "comfyui",
      workflowKey: null,
      pipelineModel: "remote-image-provider",
    };

    await expect(
      filterPublicTextToImageGenerationProfiles([descriptorless]),
    ).resolves.toEqual([]);
  });

  it("rejects active profiles that cannot serve the full public catalog", async () => {
    catalog.generationWorkflowDescriptor.mockResolvedValue({
      capabilities: ["textToImage"],
      inputs: [{ type: "text" }],
    });

    await expect(filterPublicTextToImageGenerationProfiles([
      { ...profile, rolloutPercent: 0 },
      { ...profile, maxCount: 0 },
      { ...profile, allowedOrientations: [] },
    ])).resolves.toEqual([]);
  });

  it("rejects image-input workflows from the public text-to-image catalog", async () => {
    catalog.generationWorkflowDescriptor.mockResolvedValue({
      capabilities: ["textToImage", "imageToImage"],
      inputs: [{ type: "text" }, { type: "image" }],
    });

    await expect(
      filterPublicTextToImageGenerationProfiles([profile]),
    ).resolves.toEqual([]);
  });

  it("distinguishes declared text-to-image candidates from internal image profiles", () => {
    expect(generationProfileDeclaresTextToImage(profile)).toBe(true);
    expect(generationProfileDeclaresTextToImage({
      runnerConfig: { capabilities: { textToImage: false } },
    })).toBe(false);
    expect(generationProfileDeclaresTextToImage({
      runnerConfig: { capabilities: { imageToImage: true } },
    })).toBe(false);
  });
});

describe("public image-edit workflow authority", () => {
  it("allows already published Character routes but excludes experimental, stale and text-only choices", async () => {
    const workflow = JSON.parse(await readFile(path.resolve(process.cwd(), "../gen/workflows/qwen-image-edit-multi-identity.json"), "utf8"));
    catalog.generationWorkflowDescriptor.mockResolvedValue(workflow);
    const identityProfile = { ...profile, runnerConfig: { workflowVersion: workflow.version, capabilities: { referenceImages: true } } };
    const explicitPublished = { ...identityProfile, runnerConfig: { ...identityProfile.runnerConfig, publicSelection: { explicitOnly: true, surface: "generator_character_image" } } };
    const experimental = { ...identityProfile, runnerConfig: { ...identityProfile.runnerConfig, publicSelection: { explicitOnly: true } } };
    const stale = { ...identityProfile, runnerConfig: { ...identityProfile.runnerConfig, workflowVersion: workflow.version + 1 } };
    await expect(filterPublicCharacterImageGenerationProfiles([identityProfile, explicitPublished, experimental, stale, profile,
      { ...identityProfile, rolloutPercent: 0 },
    ])).resolves.toEqual([identityProfile, explicitPublished]);
  });

  it("offers the shipped source-only and identity+source graphs, excluding stale pins and identity-only graphs", async () => {
    const workflowKeys = [
      "qwen-image-edit-img2img",
      "qwen-image-edit-multi-reference",
      "qwen-image-edit-multi-identity",
    ];
    const workflows = await Promise.all(workflowKeys.map(async (key) =>
      JSON.parse(await readFile(path.resolve(process.cwd(), `../gen/workflows/${key}.json`), "utf8")),
    ));
    catalog.generationWorkflowDescriptor.mockImplementation(async (key) =>
      workflows.find((workflow) => workflow.workflowKey === key),
    );
    const profiles = workflowKeys.map((workflowKey) => ({
      ...profile,
      workflowKey,
      runnerConfig: {
        workflowVersion: workflowKey === "qwen-image-edit-multi-reference" ? 3 : 2,
        publicSelection: { surface: "generator_image_edit" },
        capabilities: { textToImage: false, initImage: true },
      },
    }));
    const selected = await projectPublicImageEditGenerationProfiles([
      ...profiles,
      { ...profiles[1], runnerConfig: { ...profiles[1].runnerConfig, workflowVersion: 2 } },
      { ...profiles[0], runnerConfig: { ...profiles[0].runnerConfig, workflowVersion: 1 } },
      { ...profiles[0], runnerConfig: { workflowVersion: 2, capabilities: { initImage: true } } },
    ]);
    expect(selected.map(({ profile, referenceMode }) => ({ workflowKey: profile.workflowKey, referenceMode }))).toEqual([
      { workflowKey: "qwen-image-edit-img2img", referenceMode: "source_only" },
      { workflowKey: "qwen-image-edit-multi-reference", referenceMode: "identity_source" },
    ]);
  });
});
