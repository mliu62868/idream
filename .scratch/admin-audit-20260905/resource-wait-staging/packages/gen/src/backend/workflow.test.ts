import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  workflowDescriptorSchema,
  loadWorkflowDescriptors,
  type WorkflowDescriptor,
} from "./workflow";

// Resolve packages/gen/workflows relative to this test file (not process.cwd()),
// so the test works regardless of which directory vitest is invoked from.
const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../workflows",
);

function expectImageMemoryBarrier(
  descriptor: WorkflowDescriptor | undefined,
  samplerNodeId: string,
  positiveNodeId: string,
  negativeNodeId: string,
  releaseNodeId: string,
  releaseOutputIndex: number,
) {
  if (!descriptor || descriptor.backendKind !== "comfyui") {
    throw new Error("expected ComfyUI image descriptor");
  }
  expect(descriptor.apiPrompt["900:0"]).toMatchObject({
    class_type: "IDreamUnloadOffDeviceModels",
    inputs: {
      passthrough: [positiveNodeId, 0],
      after: [negativeNodeId, 0],
      release: [releaseNodeId, releaseOutputIndex],
    },
  });
  expect(descriptor.apiPrompt[samplerNodeId]?.inputs.positive).toEqual([
    "900:0",
    0,
  ]);
}

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
    expect(modelIds).toContain("redcraft-krea2-redmix3-fp8");
    expect(modelIds).toContain("redcraft-krea2-identity-edit");
  });

  it("keeps RedMix3 scaled-FP8 resident without a whole-model BF16 descriptor", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const redMix3 = descriptors.find(
      (descriptor) => descriptor.modelId === "redcraft-krea2-redmix3-fp8",
    );

    expect(redMix3).toMatchObject({
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      backendKind: "comfyui",
      version: 2,
    });
    if (!redMix3 || redMix3.backendKind !== "comfyui") {
      throw new Error("expected RedMix3 scaled-FP8 ComfyUI descriptor");
    }
    expect(redMix3.apiPrompt["1"]?.inputs).toEqual({
      unet_name: "Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors",
      weight_dtype: "default",
    });
    expect(redMix3.apiPrompt["2"]?.class_type).toBe("IDreamFreshCLIPLoader");
    expect(JSON.stringify(redMix3)).not.toContain("RedMix3.0-bf16");
    expectImageMemoryBarrier(redMix3, "7", "4", "5", "2", 0);
  });

  it("keeps full Identity Edit on FP8 residency and pre-encodes before sampling", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const identityEdit = descriptors.find(
      (descriptor) => descriptor.modelId === "redcraft-krea2-identity-edit",
    );

    expect(identityEdit).toMatchObject({
      workflowKey: "redcraft-krea2-identity-edit",
      backendKind: "comfyui",
      version: 5,
      identity: {
        mode: "single_reference",
        maxReferences: 1,
      },
    });
    if (!identityEdit || identityEdit.backendKind !== "comfyui") {
      throw new Error("expected RedCraft Identity Edit ComfyUI descriptor");
    }
    expect(identityEdit.apiPrompt["1"]?.inputs).toEqual({
      unet_name: "Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors",
      weight_dtype: "default",
    });
    expect(identityEdit.apiPrompt["2"]?.class_type).toBe(
      "IDreamFreshCLIPLoader",
    );
    expect(identityEdit.apiPrompt["4"]?.inputs).toMatchObject({
      lora_name: "Krea2/krea2_identity_edit_v1_2.safetensors",
      strength_model: 1,
    });
    expect(identityEdit.apiPrompt["6"]).toBeUndefined();
    expect(identityEdit.apiPrompt["8"]?.inputs).toMatchObject({
      source_latent: ["7", 0],
      ref_boost: 4,
      fit_mode: "fit",
      target_latent: ["7", 0],
    });
    expect(identityEdit.apiPrompt["9"]?.inputs).toMatchObject({
      grounding_px: 768,
    });
    expect(identityEdit.apiPrompt["10"]?.inputs).toMatchObject({
      grounding_px: 768,
    });
    expect(identityEdit.apiPrompt["11"]?.inputs).toMatchObject({
      steps: 8,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
    });
    expect(JSON.stringify(identityEdit)).not.toContain("RedMix3.0-bf16");
    expectImageMemoryBarrier(identityEdit, "11", "9", "10", "2", 0);
  });

  it("keeps shared RedCraft loaders cache-identical across text and identity routes", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const textToImage = descriptors.find(
      (descriptor) =>
        descriptor.workflowKey === "redcraft-krea2-redmix3-txt2img",
    );
    const identityEdit = descriptors.find(
      (descriptor) => descriptor.workflowKey === "redcraft-krea2-identity-edit",
    );

    if (
      !textToImage ||
      textToImage.backendKind !== "comfyui" ||
      !identityEdit ||
      identityEdit.backendKind !== "comfyui"
    ) {
      throw new Error("expected both RedCraft ComfyUI descriptors");
    }

    for (const classType of [
      "UNETLoader",
      "IDreamFreshCLIPLoader",
      "VAELoader",
    ]) {
      const loaderFor = (descriptor: typeof textToImage) =>
        Object.values(descriptor.apiPrompt).find(
          (node) => node.class_type === classType,
        );

      expect(loaderFor(identityEdit)).toEqual(loaderFor(textToImage));
    }
  });

  it("loads the qwen-image-edit img2img descriptor and validates it against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const qwenEdit = descriptors.find((d) => d.workflowKey === "qwen-image-edit-img2img");
    expect(qwenEdit).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(qwenEdit)).not.toThrow();
    expect(qwenEdit).toMatchObject({ version: 2 });
    expect(qwenEdit?.negativePromptMode).toBe("positive_instruction");
    if (!qwenEdit || qwenEdit.backendKind !== "comfyui") {
      throw new Error("expected Qwen image edit ComfyUI descriptor");
    }
    expect(qwenEdit.apiPrompt["1"]?.class_type).toBe(
      "IDreamCheckpointModelVaeLoader",
    );
    expect(qwenEdit.apiPrompt["1:clip"]?.class_type).toBe(
      "IDreamFreshCheckpointCLIPLoader",
    );
    expectImageMemoryBarrier(qwenEdit, "2", "3", "4", "1:clip", 0);
  });

  it("loads the two-reference Qwen identity workflow with two required semantic graph slots", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const multiIdentity = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-identity",
    );
    expect(multiIdentity).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(multiIdentity)).not.toThrow();
    expect(multiIdentity).toMatchObject({
      modelId: "qwen-image-edit-multi-identity",
      version: 2,
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
      image1: ["8", 0],
      image2: ["12", 0],
    });
    expectImageMemoryBarrier(multiIdentity, "2", "3", "4", "1:clip", 0);

    const identityAndSource = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-reference",
    );
    expect(identityAndSource).toMatchObject({
      modelId: "qwen-image-edit-multi-reference",
      version: 3,
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
      image1: ["12", 0],
      image2: ["8", 0],
    });
    expectImageMemoryBarrier(identityAndSource, "2", "3", "4", "1:clip", 0);
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
      version: 2,
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
    expect(redGraft.apiPrompt["320:333"]?.inputs).toMatchObject({
      unet_name: "redgraftLTX25Fast2K_ltx25RedgraftNSFW.safetensors",
      weight_dtype: "default",
    });
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
