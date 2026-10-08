import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindComfySlots,
  workflowDescriptorSchema,
  loadWorkflowDescriptors,
  workflowRunsWithoutReferences,
} from "./workflow";

// Resolve packages/gen/workflows relative to this test file (not process.cwd()),
// so the test works regardless of which directory vitest is invoked from.
const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../workflows",
);

// Pure-function tests (bindComfySlots/bindWorkflowArgs) and the onSkip-callback
// contract now live at packages/shared/src/gen/workflow.test.ts, alongside the
// hoisted SSoT (@idream/shared/gen-workflow). This file keeps only the test
// that reads gen's real on-disk workflows/ directory through the thin shell,
// since that fixture is gen-specific.
describe("loadWorkflowDescriptors (real files on disk)", () => {
  it("loads every on-disk descriptor and validates them against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    expect(descriptors.length).toBeGreaterThan(0);
    for (const descriptor of descriptors) {
      expect(() => workflowDescriptorSchema.parse(descriptor)).not.toThrow();
    }
    const modelIds = descriptors.map((descriptor) => descriptor.modelId);
    expect(modelIds).toContain("redqw21");
    expect(modelIds).toContain("redqw21-image-edit");
    expect(modelIds.some((modelId) => /krea/i.test(modelId))).toBe(false);
  });

  it("retires every Rapid-AIO weight while keeping the three image-input contracts on REDQW21 V2", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    expect(JSON.stringify(descriptors)).not.toContain("Qwen-Rapid-AIO-NSFW-v19");
    for (const key of ["redqw21", "qwen-image-edit-img2img", "qwen-image-edit-multi-reference", "qwen-image-edit-multi-identity"]) {
      const workflow = descriptors.find((descriptor) => descriptor.workflowKey === key);
      if (!workflow || workflow.backendKind !== "comfyui") throw new Error(`missing ${key}`);
      const encoder = Object.values(workflow.apiPrompt).find((node) => node.class_type === "IDreamFreshCLIPLoader");
      expect(encoder?.inputs).toMatchObject({ clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: key === "redqw21" ? "cpu" : "mps" });
      expect(Object.values(workflow.apiPrompt).filter((node) => node.class_type === "IDreamQwen21VAELoader")).toHaveLength(1);
    }
    for (const key of ["qwen-image-edit-img2img", "qwen-image-edit-multi-reference", "qwen-image-edit-multi-identity"]) {
      const workflow = descriptors.find((descriptor) => descriptor.workflowKey === key);
      if (!workflow || workflow.backendKind !== "comfyui") throw new Error(`missing ${key}`);
      expect(workflow.apiPrompt["1"]?.inputs.unet_name).toBe("redqw21_unlocked_v2_bf16.safetensors");
      const references = Object.fromEntries(workflow.inputs.filter((slot) => slot.type === "image").map((slot) => [slot.key, `${slot.key}.png`]));
      expect(bindComfySlots(workflow, { prompt: "test", width: 512, height: 640, seed: 1, ...references })["9"]?.inputs).toMatchObject({ width: 512, height: 640 });
    }
  });

  it.each([
    ["qwen-image-edit-img2img", ["3", 2]],
    ["qwen-image-edit-multi-reference", ["3", 2]],
    ["qwen-image-edit-multi-identity", ["9", 0]],
  ])("uses the six-step adapter and GPU positive-only conditioning for %s", async (key, latent) => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const workflow = descriptors.find((descriptor) => descriptor.workflowKey === key);
    if (!workflow || workflow.backendKind !== "comfyui") throw new Error(`missing ${key}`);
    const references = Object.fromEntries(workflow.inputs.filter((slot) => slot.type === "image").map((slot) => [slot.key, `${slot.key}.png`]));
    const graph = bindComfySlots(workflow, { prompt: "change shirt", seed: 4115733296, steps: 6, ...references });
    expect(graph["3"]).toMatchObject({ class_type: "IDreamQwen21TextEncode", inputs: { cfg: 1 } });
    expect(graph["4"]?.inputs.device).toBe("mps");
    expect(graph["1:lora"]).toMatchObject({
      class_type: "IDreamQwen21TurboLora",
      inputs: { model: ["1:cache", 0], lora_name: "Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors" },
    });
    expect(graph["2:guider"]).toMatchObject({ class_type: "BasicGuider", inputs: { model: ["1:lora", 0], conditioning: ["900:0", 0] } });
    expect(graph["2:sigmas"]).toMatchObject({ class_type: "IDreamQwen21TurboSigmas", inputs: { latent, steps: 6 } });
    expect(graph["2:noise"]?.inputs.noise_seed).toBe(4115733296);
    expect(graph["2:sampler"]?.inputs.sampler_name).toBe("euler");
    expect(graph["2"]).toMatchObject({
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["2:noise", 0], guider: ["2:guider", 0], sampler: ["2:sampler", 0], sigmas: ["2:sigmas", 0], latent_image: latent },
    });
    expect(workflow.inputs.find((slot) => slot.key === "steps")?.default).toBe(6);
    expect(graph["900:0"]?.inputs).toEqual({ passthrough: ["3", 0], after: ["3", 1], release: ["4", 0] });
    expect(Object.values(graph).some((node) => node.class_type === "KSampler")).toBe(false);
  });

  it("serves REDQW21 text-to-image and single-anchor identity from one graph", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const redqw21 = descriptors.find((descriptor) => descriptor.workflowKey === "redqw21");
    if (!redqw21 || redqw21.backendKind !== "comfyui") throw new Error("redqw21 descriptor must load");
    expect(workflowRunsWithoutReferences(redqw21)).toBe(true);
    expect(redqw21.identity).toMatchObject({ mode: "single_reference", maxReferences: 1 });
    // INVARIANT: the 8B text encoder is released at the barrier after both
    // conditioning outputs of the single TextEncodeQwenImage21 node exist.
    expect(redqw21.apiPrompt["900:0"]?.inputs).toEqual({
      passthrough: ["5", 0],
      after: ["5", 1],
      release: ["2", 0],
    });
    expect(redqw21.apiPrompt["2"]).toMatchObject({
      class_type: "IDreamFreshCLIPLoader",
      inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "cpu" },
    });
    expect(bindComfySlots(redqw21, { prompt: "p", seed: 1 })["10"]).toBeUndefined();
    expect(bindComfySlots(redqw21, { prompt: "p", seed: 1, identity_image: "a.png" })["5"]?.inputs["images.image_1"])
      .toEqual(["10", 0]);
  });

  it("loads the qwen-image-edit img2img descriptor and validates it against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const qwenEdit = descriptors.find((d) => d.workflowKey === "qwen-image-edit-img2img");
    expect(qwenEdit).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(qwenEdit)).not.toThrow();
    expect(qwenEdit).toMatchObject({ modelId: "redqw21-image-edit", version: 5 });
    expect(qwenEdit?.negativePromptMode).toBe("positive_instruction");
    if (!qwenEdit || qwenEdit.backendKind !== "comfyui") {
      throw new Error("expected Qwen image edit ComfyUI descriptor");
    }
    expect(qwenEdit.apiPrompt["1"]?.class_type).toBe(
      "UNETLoader",
    );
    expect(qwenEdit.apiPrompt["4"]?.class_type).toBe(
      "IDreamFreshCLIPLoader",
    );
    expect(qwenEdit.apiPrompt["900:0"]?.inputs).toEqual({ passthrough: ["3", 0], after: ["3", 1], release: ["4", 0] });
    // INVARIANT: the distilled adapter uses its author grid and positive-only
    // guidance; ordinary simple/Euler sigmas or merged BF16 LoRA lose fidelity.
    expect(qwenEdit.apiPrompt["3"]).toMatchObject({ class_type: "IDreamQwen21TextEncode", inputs: { cfg: 1, resolution: 0 } });
    expect(qwenEdit.apiPrompt["1:lora"]).toMatchObject({
      class_type: "IDreamQwen21TurboLora",
      inputs: { model: ["1:cache", 0], lora_name: "Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors" },
    });
    expect(qwenEdit.apiPrompt["2:guider"]).toMatchObject({ class_type: "BasicGuider", inputs: { model: ["1:lora", 0], conditioning: ["900:0", 0] } });
    expect(qwenEdit.apiPrompt["2:sigmas"]).toMatchObject({ class_type: "IDreamQwen21TurboSigmas", inputs: { latent: ["3", 2], steps: 6 } });
    expect(qwenEdit.apiPrompt["2"]?.inputs).toMatchObject({ guider: ["2:guider", 0], sigmas: ["2:sigmas", 0], latent_image: ["3", 2] });
    expect(bindComfySlots(qwenEdit, { prompt: "change shirt", source_image: "source.png", seed: 7 })["2:noise"]?.inputs.noise_seed).toBe(7);
  });

  it("loads the two-reference Qwen identity workflow with two required semantic graph slots", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const multiIdentity = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-identity",
    );
    expect(multiIdentity).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(multiIdentity)).not.toThrow();
    expect(multiIdentity).toMatchObject({
      modelId: "redqw21-multi-identity",
      version: 6,
      identity: {
        mode: "multi_identity",
        maxReferences: 2,
        acceptedRoles: [
          "identity_anchor",
          "identity_reference",
          "look_reference",
        ],
        supportsLookReference: true,
        supportsSourceImageWithIdentity: false,
      },
    });
    if (!multiIdentity || multiIdentity.backendKind !== "comfyui") {
      throw new Error("expected Qwen multi-identity ComfyUI descriptor");
    }
    const imageSlots = multiIdentity.inputs.filter((input) => input.type === "image");
    expect(imageSlots).toEqual([
      expect.objectContaining({
        key: "identity_anchor",
        required: true,
        referenceRoles: ["identity_anchor"],
        target: { nodeId: "8", field: "image" },
      }),
      expect.objectContaining({
        key: "identity_reference",
        required: true,
        referenceRoles: ["identity_reference", "look_reference"],
        target: { nodeId: "12", field: "image" },
      }),
    ]);
    expect(multiIdentity.apiPrompt["3"]?.inputs).toMatchObject({
      resolution: 1024,
      "images.image_1": ["8", 0],
      "images.image_2": ["12", 0],
    });
    expect(multiIdentity.apiPrompt["900:0"]?.inputs).toEqual({ passthrough: ["3", 0], after: ["3", 1], release: ["4", 0] });

    const identityAndSource = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-reference",
    );
    expect(identityAndSource).toMatchObject({
      modelId: "redqw21-multi-reference",
      version: 7,
      identity: {
        mode: "multi_reference",
        maxReferences: 2,
        acceptedRoles: [
          "identity_anchor",
          "identity_reference",
          "source_image",
        ],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
    });
    if (!identityAndSource || identityAndSource.backendKind !== "comfyui") {
      throw new Error("expected Qwen identity-plus-source ComfyUI descriptor");
    }
    expect(
      identityAndSource.inputs.filter((input) => input.type === "image"),
    ).toEqual([
      expect.objectContaining({
        key: "identity_image",
        referenceRoles: ["identity_anchor", "identity_reference"],
        target: { nodeId: "8", field: "image" },
      }),
      expect.objectContaining({
        key: "source_image",
        referenceRoles: ["source_image"],
        target: { nodeId: "12", field: "image" },
      }),
    ]);
    expect(identityAndSource.apiPrompt["3"]?.inputs).toMatchObject({
      resolution: 0,
      "images.image_1": ["9", 0],
      "images.image_2": ["8:scale", 0],
    });
    expect(identityAndSource.apiPrompt["8:scale"]).toEqual({
      class_type: "ImageScaleToTotalPixels",
      inputs: { image: ["8", 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 32 },
    });
    expect(identityAndSource.apiPrompt["9"]?.inputs.image).toEqual(["12", 0]);
    expect(identityAndSource.apiPrompt["2"]?.inputs.latent_image).toEqual(["3", 2]);
    expect(identityAndSource.apiPrompt["900:0"]?.inputs).toEqual({ passthrough: ["3", 0], after: ["3", 1], release: ["4", 0] });
  });

  it("loads the opt-in Draw Things Pornmaster descriptor", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const drawThings = descriptors.find((d) => d.modelId === "pornmaster-zimage-drawthings");
    expect(drawThings).toBeDefined();
    expect(drawThings?.backendKind).toBe("drawthings");
  });

  it("loads RedGraft LTX 2.5 as an explicit five-second I2V workflow", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const redGraft = descriptors.find(
      (descriptor) => descriptor.workflowKey === "redgraft-ltx25-i2v",
    );

    expect(() => workflowDescriptorSchema.parse(redGraft)).not.toThrow();
    expect(redGraft).toMatchObject({
      modelId: "redgraft-ltx25-fast2k-int8-convrot",
      backendKind: "comfyui",
      version: 5,
      capabilities: [
        "video",
        "img2video",
        "referenceImages",
        "stableSeed",
        "audio",
      ],
      identity: {
        mode: "single_reference",
        maxReferences: 1,
        acceptedRoles: ["source_image"],
      },
    });
    if (!redGraft || redGraft.backendKind !== "comfyui") {
      throw new Error("expected RedGraft LTX 2.5 ComfyUI descriptor");
    }
    expect(redGraft.apiPrompt["320:335"]).toMatchObject({
      class_type: "IDreamGemma4MLXCLIPLoader",
      inputs: { clip_name: "gemma4-12b-ltx-v1-mlx-q8.safetensors" },
    });
    expect(redGraft.apiPrompt["900:3"]?.inputs).toMatchObject({
      after: ["900:1", 0], release: ["320:335", 0],
    });
    expect(redGraft.apiPrompt["320:333"]?.inputs).toMatchObject({
      unet_name: "redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors",
      weight_dtype: "default",
    });
    expect(redGraft.apiPrompt["900:4"]).toMatchObject({
      class_type: "IDreamMPSGraphAttention",
      inputs: { model: ["320:333", 0], compute_precision: "bf16" },
    });
    for (const id of ["320:282", "320:314"]) {
      expect(redGraft.apiPrompt[id]?.inputs.model).toEqual(["900:4", 0]);
    }
    expect(redGraft.apiPrompt["75"]?.inputs).toMatchObject({
      filename_prefix: "idream-redgraft-ltx25",
    });
    expect(redGraft.inputs).toContainEqual(
      expect.objectContaining({
        key: "negative",
        target: { nodeId: "900:0", field: "text" },
      }),
    );
  });

  it("keeps MiniMax H3 exact on its dedicated production runner", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const h3 = descriptors.find(
      (descriptor) => descriptor.workflowKey === "minimax-h3-redcraft-i2v",
    );

    expect(h3).toMatchObject({ version: 4 });
    if (!h3 || h3.backendKind !== "comfyui") {
      throw new Error("expected MiniMax H3 ComfyUI descriptor");
    }
    expect(h3.apiPrompt["17"]).toBeUndefined();
    expect(h3.apiPrompt["2"]?.inputs.model).toEqual(["1", 0]);
  });



});
