import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workflowDescriptorSchema, loadWorkflowDescriptors } from "./workflow";

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
    expect(descriptors.map((d) => d.modelId)).toContain("redcraft-krea2-redmix3-fp8");
  });

  it("loads RedMix3 as an isolated 12-step Krea2 comparison workflow", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const redMix3 = descriptors.find(
      (descriptor) =>
        descriptor.workflowKey === "redcraft-krea2-redmix3-txt2img",
    );

    expect(() => workflowDescriptorSchema.parse(redMix3)).not.toThrow();
    expect(redMix3).toMatchObject({
      modelId: "redcraft-krea2-redmix3-fp8",
      backendKind: "comfyui",
      version: 1,
      capabilities: ["textToImage", "stableSeed"],
      identity: {
        mode: "none",
        maxReferences: 0,
        acceptedRoles: [],
      },
    });
    if (!redMix3 || redMix3.backendKind !== "comfyui") {
      throw new Error("expected RedMix3 ComfyUI descriptor");
    }
    expect(redMix3.apiPrompt["1"]?.inputs).toEqual({
      unet_name: "Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors",
      weight_dtype: "default",
    });
    expect(redMix3.apiPrompt["7"]?.inputs).toMatchObject({
      steps: 12,
      cfg: 1,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
    });
  });

  it("loads the qwen-image-edit img2img descriptor and validates it against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const qwenEdit = descriptors.find((d) => d.workflowKey === "qwen-image-edit-img2img");
    expect(qwenEdit).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(qwenEdit)).not.toThrow();
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

    const identityAndSource = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-reference",
    );
    expect(identityAndSource).toMatchObject({
      modelId: "qwen-image-edit-multi-reference",
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
      image1: ["8", 0],
      image2: ["12", 0],
    });
  });

  it("loads the Dark Beast Klein identity-plus-source workflow as a separate Qwen comparison candidate", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const darkBeast = descriptors.find(
      (descriptor) =>
        descriptor.workflowKey === "darkbeast-flux2-klein-9b-multi-reference",
    );

    expect(() => workflowDescriptorSchema.parse(darkBeast)).not.toThrow();
    expect(darkBeast).toMatchObject({
      modelId: "darkbeast-flux2-klein-9b-bfs",
      backendKind: "comfyui",
      capabilities: ["img2img", "edit", "referenceImages", "stableSeed"],
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
    if (!darkBeast || darkBeast.backendKind !== "comfyui") {
      throw new Error("expected Dark Beast Klein ComfyUI descriptor");
    }
    expect(
      darkBeast.inputs.filter((input) => input.type === "image"),
    ).toEqual([
      expect.objectContaining({
        key: "identity_image",
        required: true,
        referenceRoles: ["identity_anchor", "identity_reference"],
        target: { nodeId: "6", field: "image" },
      }),
      expect.objectContaining({
        key: "source_image",
        required: true,
        referenceRoles: ["source_image"],
        target: { nodeId: "10", field: "image" },
      }),
    ]);
    expect(darkBeast.apiPrompt["1"]?.inputs).toEqual({
      unet_name: "darkBeastINT8Convrot2_dbkleinv2BFS.safetensors",
      weight_dtype: "default",
    });
    expect(darkBeast.apiPrompt["2"]?.inputs).toEqual({
      clip_name: "qwen_3_8b_fp8mixed.safetensors",
      type: "flux2",
      device: "default",
    });
    expect(darkBeast.apiPrompt["12"]?.inputs).toMatchObject({
      conditioning: ["8", 0],
      latent: ["11", 0],
    });
    expect(darkBeast.apiPrompt["13"]?.inputs).toMatchObject({
      conditioning: ["9", 0],
      latent: ["11", 0],
    });
    expect(darkBeast.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "width",
          target: { nodeId: "14", field: "width" },
          additionalTargets: [{ nodeId: "15", field: "width" }],
          default: 832,
        }),
        expect.objectContaining({
          key: "height",
          target: { nodeId: "14", field: "height" },
          additionalTargets: [{ nodeId: "15", field: "height" }],
          default: 1216,
        }),
      ]),
    );
  });

  it("loads the opt-in Draw Things Pornmaster descriptor", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const drawThings = descriptors.find((d) => d.modelId === "pornmaster-zimage-drawthings");
    expect(drawThings).toBeDefined();
    expect(drawThings?.backendKind).toBe("drawthings");
  });



});
