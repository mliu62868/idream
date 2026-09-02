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

  it("keeps descriptor-less pipeline profiles available when they declare text-to-image", async () => {
    catalog.generationWorkflowDescriptor.mockResolvedValue(null);
    const pipelineProfile = {
      ...profile,
      runner: "pipeline",
      workflowKey: null,
      pipelineModel: "remote-image-provider",
    };

    await expect(
      filterPublicTextToImageGenerationProfiles([pipelineProfile]),
    ).resolves.toEqual([pipelineProfile]);
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
        workflowVersion: 2,
        publicSelection: { surface: "generator_image_edit" },
        capabilities: { textToImage: false, initImage: true },
      },
    }));
    const selected = await projectPublicImageEditGenerationProfiles([
      ...profiles,
      { ...profiles[0], runnerConfig: { ...profiles[0].runnerConfig, workflowVersion: 1 } },
      { ...profiles[0], runnerConfig: { workflowVersion: 2, capabilities: { initImage: true } } },
    ]);
    expect(selected.map(({ profile, referenceMode }) => ({ workflowKey: profile.workflowKey, referenceMode }))).toEqual([
      { workflowKey: "qwen-image-edit-img2img", referenceMode: "source_only" },
      { workflowKey: "qwen-image-edit-multi-reference", referenceMode: "identity_source" },
    ]);
  });
});
