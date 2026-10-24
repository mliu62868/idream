import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignWorkflowReferenceSlots,
  bindComfySlots,
  workflowDescriptorSchema,
  loadWorkflowDescriptors,
  workflowRunsWithoutReferences,
  type ComfyNode,
  type WorkflowReferenceRole,
} from "./workflow";

// Resolve packages/gen/workflows relative to this test file (not process.cwd()),
// so the test works regardless of which directory vitest is invoked from.
const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../workflows",
);

function expectConnectedGraph(graph: Record<string, ComfyNode>) {
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") {
        expect(graph[value[0]], `${nodeId}.${input} links to missing node ${value[0]}`).toBeDefined();
        expect(Number.isInteger(value[1]) && value[1] >= 0, `${nodeId}.${input} has an invalid output index`).toBe(true);
      }
    }
  }
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
    expect(modelIds).toEqual(expect.arrayContaining([
      "redcraft-qw21t", "redcraft-image-edit", "redcraft-multi-identity", "redcraft-multi-reference",
    ]));
    expect(modelIds.some((modelId) => modelId.startsWith("redqw21"))).toBe(false);
    expect(modelIds.some((modelId) => /krea/i.test(modelId))).toBe(false);
  });

  it.each([
    "redcraft-qw21t",
    "qwen-image-edit-img2img",
    "qwen-image-edit-multi-reference",
    "qwen-image-edit-multi-identity",
  ])("shares the same FineView model, encoder and VAE in %s", async (key) => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const workflow = descriptors.find((descriptor) => descriptor.workflowKey === key);
    if (!workflow || workflow.backendKind !== "comfyui") throw new Error(`missing ${key}`);
    const nodes = Object.values(workflow.apiPrompt);
    expect(nodes.filter((node) => node.class_type === "UNETLoader")).toEqual([
      { class_type: "UNETLoader", inputs: { unet_name: "fineview_qw21_turbo_fixed_int8.safetensors", weight_dtype: "default" } },
    ]);
    expect(nodes.filter((node) => node.class_type === "IDreamFreshCLIPLoader")).toEqual([
      { class_type: "IDreamFreshCLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "mps" } },
    ]);
    expect(nodes.filter((node) => node.class_type === "IDreamQwen21VAELoader")).toEqual([
      { class_type: "IDreamQwen21VAELoader", inputs: { vae_name: "texture_fix_vae_for_qwen_image_2.1_bf16.safetensors" } },
    ]);
    expect(nodes.some((node) => /Lora|TurboSigmas|SamplerCustomAdvanced/.test(node.class_type))).toBe(false);
    expectConnectedGraph(workflow.apiPrompt);
  });

  it.each([
    ["qwen-image-edit-img2img", ["3", 2]],
    ["qwen-image-edit-multi-reference", ["3", 2]],
    ["qwen-image-edit-multi-identity", ["9", 0]],
  ])("uses the resident six-step FineView recipe while preserving the latent contract in %s", async (key, latent) => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const workflow = descriptors.find((descriptor) => descriptor.workflowKey === key);
    if (!workflow || workflow.backendKind !== "comfyui") throw new Error(`missing ${key}`);
    const references = Object.fromEntries(workflow.inputs.filter((slot) => slot.type === "image").map((slot) => [slot.key, `${slot.key}.png`]));
    const graph = bindComfySlots(workflow, { prompt: "change shirt", width: 512, height: 640, seed: 4115733296, ...references });
    expect(graph["3"]).toMatchObject({ class_type: "IDreamQwen21TextEncode", inputs: { cfg: 1 } });
    expect(graph["1:resident"]).toEqual({ class_type: "IDreamQwen21ResidentWeights", inputs: { model: ["1", 0] } });
    expect(graph["1:cache"]).toMatchObject({ class_type: "QwenImage21Cache", inputs: { model: ["1:resident", 0] } });
    expect(graph["1:shift"]).toEqual({ class_type: "ModelSamplingAuraFlow", inputs: { model: ["1:cache", 0], shift: 1.31, sampling: "flow" } });
    expect(graph["2"]).toEqual({ class_type: "KSampler", inputs: {
      model: ["1:shift", 0], positive: ["900:0", 0], negative: ["3", 1], latent_image: latent,
      seed: 4115733296, steps: 6, cfg: 1, sampler_name: "er_sde", scheduler: "simple", denoise: 1,
    } });
    expect(Object.values(graph).filter((node) => ["KSampler", "SamplerCustomAdvanced"].includes(node.class_type))).toHaveLength(1);
    expect(workflow.inputs.find((slot) => slot.key === "steps")?.default).toBe(6);
    expect(graph["900:0"]?.inputs).toEqual({ passthrough: ["3", 0], after: ["3", 1], release: ["4", 0] });
    expect(graph["9"]?.inputs).toMatchObject({ width: 512, height: 640 });
    expect(graph["10"]?.inputs).toEqual({ samples: ["2", 0], vae: ["5", 0] });
    expect(graph["11"]?.inputs.images).toEqual(["10", 0]);
    expectConnectedGraph(graph);
  });

  it("serves RedCraft text-to-image and one reference with the measured six-step default recipe", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const workflow = descriptors.find((d) => d.workflowKey === "redcraft-qw21t");
    if (!workflow || workflow.backendKind !== "comfyui") throw new Error("missing RedCraft workflow");
    expect(workflowRunsWithoutReferences(workflow)).toBe(true);
    expect(workflow.version).toBe(3);
    expect(workflow.inputs.find((slot) => slot.key === "steps")?.default).toBe(6);
    expect(workflow.identity.maxReferences).toBe(1);
    const referenceCases: Record<string, string>[] = [{}, { source_image: "adult-portrait.png" }];
    for (const references of referenceCases) {
      const graph = bindComfySlots(workflow, { prompt: "a blue jacket", seed: 123, width: 832, height: 1024, ...references });
      expect(graph["1"]?.inputs.unet_name).toBe("fineview_qw21_turbo_fixed_int8.safetensors");
      expect(graph["1:resident"]).toMatchObject({ class_type: "IDreamQwen21ResidentWeights", inputs: { model: ["1", 0] } });
      expect(graph["4"]?.inputs.model).toEqual(["1:resident", 0]);
      expect(graph["3"]?.inputs.vae_name).toBe("texture_fix_vae_for_qwen_image_2.1_bf16.safetensors");
      expect(graph["2"]?.inputs.device).toBe("mps");
      expect(graph["4:shift"]).toMatchObject({ class_type: "ModelSamplingAuraFlow", inputs: { model: ["4", 0], shift: 1.31, sampling: "flow" } });
      expect(graph["7"]).toEqual({ class_type: "KSampler", inputs: {
        model: ["4:shift", 0], positive: ["900:0", 0], negative: ["5", 1],
        latent_image: ["6", 0], seed: 123, steps: 6, cfg: 1,
        sampler_name: "er_sde", scheduler: "simple", denoise: 1,
      } });
      expect(Object.values(graph).filter((node) => ["KSampler", "SamplerCustomAdvanced"].includes(node.class_type))).toHaveLength(1);
      expect(Object.values(graph).some((node) => node.class_type === "IDreamQwen21TurboSigmas")).toBe(false);
      expect(Object.values(graph).some((node) => /Lora/.test(node.class_type))).toBe(false);
      // Optional input removal must not leave a required resize node or dangling link.
      expect(graph["5"]?.inputs["images.image_1"]).toEqual("source_image" in references ? ["10", 0] : undefined);
      expectConnectedGraph(graph);
    }
  });

  it("loads the qwen-image-edit img2img descriptor and validates it against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const qwenEdit = descriptors.find((d) => d.workflowKey === "qwen-image-edit-img2img");
    expect(qwenEdit).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(qwenEdit)).not.toThrow();
    expect(qwenEdit).toMatchObject({ modelId: "redcraft-image-edit", version: 6 });
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
    // Editing retains the resized source latent and native geometry; the
    // text-only default instead samples an empty latent of the requested size.
    expect(workflowRunsWithoutReferences(qwenEdit)).toBe(false);
    expect(qwenEdit.apiPrompt["3"]).toMatchObject({ class_type: "IDreamQwen21TextEncode", inputs: {
      cfg: 1, resolution: 0, "images.image_1": ["9", 0],
    } });
    expect(qwenEdit.apiPrompt["9"]?.inputs.image).toEqual(["8", 0]);
    expect(qwenEdit.apiPrompt["2"]?.inputs.latent_image).toEqual(["3", 2]);
    expect(bindComfySlots(qwenEdit, { prompt: "change shirt", source_image: "source.png", seed: 7 })["2"]?.inputs.seed).toBe(7);
    expect(assignWorkflowReferenceSlots(qwenEdit, []).ok).toBe(false);
    for (const role of ["identity_anchor", "identity_reference", "source_image"] as const) {
      expect(assignWorkflowReferenceSlots(qwenEdit, [role])).toMatchObject({
        ok: true, assignments: [{ slotKey: "source_image", referenceIndex: 0 }],
      });
    }
    expect(assignWorkflowReferenceSlots(qwenEdit, ["look_reference"]).ok).toBe(false);
  });

  it("loads the two-reference Qwen identity workflow with two required semantic graph slots", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const multiIdentity = descriptors.find(
      (descriptor) => descriptor.workflowKey === "qwen-image-edit-multi-identity",
    );
    expect(multiIdentity).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(multiIdentity)).not.toThrow();
    expect(multiIdentity).toMatchObject({
      modelId: "redcraft-multi-identity",
      version: 7,
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
      modelId: "redcraft-multi-reference",
      version: 8,
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

  it.each([
    {
      workflowKey: "qwen-image-edit-multi-identity",
      supportingRole: "identity_reference",
      primaryRole: "identity_anchor",
      primarySlot: "identity_anchor",
      supportingSlot: "identity_reference",
    },
    {
      workflowKey: "qwen-image-edit-multi-identity",
      supportingRole: "look_reference",
      primaryRole: "identity_anchor",
      primarySlot: "identity_anchor",
      supportingSlot: "identity_reference",
    },
    {
      workflowKey: "qwen-image-edit-multi-reference",
      supportingRole: "source_image",
      primaryRole: "identity_anchor",
      primarySlot: "identity_image",
      supportingSlot: "source_image",
    },
    {
      workflowKey: "qwen-image-edit-multi-reference",
      supportingRole: "source_image",
      primaryRole: "identity_reference",
      primarySlot: "identity_image",
      supportingSlot: "source_image",
    },
  ] as const)("assigns $primaryRole and $supportingRole by role in $workflowKey, regardless of upload order", async (contract) => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    const workflow = descriptors.find((descriptor) => descriptor.workflowKey === contract.workflowKey);
    if (!workflow || workflow.backendKind !== "comfyui") throw new Error(`missing ${contract.workflowKey}`);
    expect(workflowRunsWithoutReferences(workflow)).toBe(false);
    for (const roles of [
      [contract.primaryRole, contract.supportingRole],
      [contract.supportingRole, contract.primaryRole],
    ]) {
      const assignment = assignWorkflowReferenceSlots(workflow, roles);
      expect(assignment).toMatchObject({ ok: true, minReferences: 2, maxReferences: 2 });
      if (!assignment.ok) throw new Error("semantic references must bind");
      expect(assignment.assignments).toEqual(expect.arrayContaining([
        { slotKey: contract.primarySlot, referenceIndex: roles.indexOf(contract.primaryRole) },
        { slotKey: contract.supportingSlot, referenceIndex: roles.indexOf(contract.supportingRole) },
      ]));
      expect(assignment.assignments).toHaveLength(2);
    }
    const unsupported: WorkflowReferenceRole = contract.workflowKey === "qwen-image-edit-multi-identity"
      ? "source_image" : "look_reference";
    for (const invalid of [[], [contract.primaryRole], [contract.supportingRole, contract.supportingRole], [contract.primaryRole, unsupported]]) {
      expect(assignWorkflowReferenceSlots(workflow, invalid).ok).toBe(false);
    }
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
