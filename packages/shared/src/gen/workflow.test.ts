import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  workflowDescriptorSchema,
  assignWorkflowReferenceSlots,
  bindComfySlots,
  bindWorkflowArgs,
  loadWorkflowDescriptors,
} from "./workflow";

const comfyDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "t2i",
  modelId: "redcraft-krea2-redmix3-fp8",
  backendKind: "comfyui",
  comfyWorkflow: { id: "11111111-1111-4111-8111-111111111111", name: "Test T2I" },
  version: 1,
  capabilities: ["textToImage", "stableSeed"],
  apiPrompt: {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
    "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20 } },
  },
  inputs: [
    { key: "prompt", type: "text", target: { nodeId: "6", field: "text" } },
    { key: "width", type: "int", target: { nodeId: "5", field: "width" }, default: 832 },
    { key: "seed", type: "int", target: { nodeId: "3", field: "seed" } },
  ],
});
if (comfyDescriptor.backendKind !== "comfyui") throw new Error("expected ComfyUI descriptor");

describe("bindComfySlots", () => {
  it("injects values into declared node fields and applies defaults", () => {
    const p = bindComfySlots(comfyDescriptor, { prompt: "a cat", seed: 42 });
    expect(p["6"].inputs.text).toBe("a cat");
    expect(p["5"].inputs.width).toBe(832); // default
    expect(p["3"].inputs.seed).toBe(42);
  });
  it("does not mutate the descriptor's apiPrompt", () => {
    bindComfySlots(comfyDescriptor, { prompt: "x", seed: 1 });
    expect(comfyDescriptor.apiPrompt["6"].inputs.text).toBe("");
  });
  it("throws when a required slot (no default) is missing", () => {
    expect(() => bindComfySlots(comfyDescriptor, { prompt: "x" })).toThrow(/seed/);
  });

  it("binds one semantic control to its primary and additional graph targets", () => {
    const descriptor = workflowDescriptorSchema.parse({
      workflowKey: "flux2-dynamic-size",
      modelId: "flux2-model",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "11111111-1111-4111-8111-111111111112",
        name: "FLUX.2 Dynamic Size",
      },
      version: 1,
      capabilities: ["textToImage"],
      apiPrompt: {
        "14": {
          class_type: "EmptyFlux2LatentImage",
          inputs: { width: 832 },
        },
        "15": {
          class_type: "Flux2Scheduler",
          inputs: { width: 832 },
        },
      },
      inputs: [{
        key: "width",
        type: "int",
        target: { nodeId: "14", field: "width" },
        additionalTargets: [{ nodeId: "15", field: "width" }],
        default: 832,
      }],
    });

    const prompt = bindComfySlots(descriptor, { width: 1024 });
    expect(prompt["14"].inputs.width).toBe(1024);
    expect(prompt["15"].inputs.width).toBe(1024);
  });
});

// SPEC: identity-contract self-consistency is backend-agnostic. The
// descriptor-level superRefine early-returns for command backends, so these
// checks live on the identity schema itself — otherwise a Draw Things descriptor
// can declare a reference mode it can never actually satisfy.
describe("identity contract consistency (all backends)", () => {
  function drawThingsDescriptor(identity: Record<string, unknown>) {
    return {
      workflowKey: "dt-t2i",
      modelId: "dt-model",
      backendKind: "drawthings",
      version: 1,
      capabilities: ["textToImage", "img2img"],
      identity,
      drawThings: { model: "dt.ckpt" },
      inputs: [{ key: "prompt", type: "text", target: { argFlag: "--prompt" } }],
    };
  }

  it("rejects a command-backend contract that accepts roles with a zero reference budget", () => {
    expect(() =>
      workflowDescriptorSchema.parse(drawThingsDescriptor({
        mode: "single_reference",
        maxReferences: 0,
        acceptedRoles: ["source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: false,
      })),
    ).toThrow(/at least one reference/);
  });

  it("rejects a command-backend contract whose mode is none but still accepts roles", () => {
    expect(() =>
      workflowDescriptorSchema.parse(drawThingsDescriptor({
        mode: "none",
        maxReferences: 1,
        acceptedRoles: ["source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: false,
      })),
    ).toThrow(/mode none/);
  });

  it("accepts a self-consistent command-backend img2img contract", () => {
    const descriptor = workflowDescriptorSchema.parse(drawThingsDescriptor({
      mode: "single_reference",
      maxReferences: 1,
      acceptedRoles: ["source_image"],
      supportsLookReference: false,
      supportsSourceImageWithIdentity: false,
    }));

    // Command backends have no graph slots, so maxReferences stays an
    // upper-bound capability contract — one source_image must now fit.
    expect(assignWorkflowReferenceSlots(descriptor, ["source_image"])).toMatchObject({
      ok: true,
      maxReferences: 1,
    });
  });

  it("rejects duplicate accepted roles", () => {
    expect(() =>
      workflowDescriptorSchema.parse(drawThingsDescriptor({
        mode: "single_reference",
        maxReferences: 2,
        acceptedRoles: ["source_image", "source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: false,
      })),
    ).toThrow(/unique/);
  });
});

describe("workflow identity capability contract", () => {
  it("parses an explicit identity-routing and quality contract", () => {
    const descriptor = workflowDescriptorSchema.parse({
      workflowKey: "identity-edit",
      modelId: "identity-model",
      backendKind: "comfyui",
      comfyWorkflow: { id: "22222222-2222-4222-8222-222222222222", name: "Identity Edit" },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "single_reference",
        maxReferences: 1,
        acceptedRoles: ["identity_anchor", "source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: false,
      },
      quality: {
        maxCandidates: 2,
        evaluatorDimensions: ["artifact", "identity", "intent"],
      },
      apiPrompt: {
        "8": { class_type: "LoadImage", inputs: { image: "" } },
      },
      inputs: [{
        key: "identity_image",
        type: "image",
        referenceRoles: ["identity_anchor", "source_image"],
        target: { nodeId: "8", field: "image" },
      }],
    });

    expect(descriptor.identity).toMatchObject({
      mode: "single_reference",
      maxReferences: 1,
      acceptedRoles: ["identity_anchor", "source_image"],
    });
    expect(descriptor.quality.evaluatorDimensions).toEqual(["artifact", "identity", "intent"]);
  });

  it("requires and assigns two canonical identity references without a source image", () => {
    const descriptor = workflowDescriptorSchema.parse({
      workflowKey: "multi-identity-edit",
      modelId: "multi-identity-model",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "22222222-2222-4222-8222-222222222229",
        name: "Two Identity References",
      },
      version: 1,
      capabilities: ["edit", "referenceImages"],
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
      apiPrompt: {
        "3": {
          class_type: "TextEncodeQwenImageEditPlus",
          inputs: { image1: ["8", 0], image2: ["12", 0] },
        },
        "8": { class_type: "LoadImage", inputs: { image: "" } },
        "12": { class_type: "LoadImage", inputs: { image: "" } },
      },
      inputs: [
        {
          key: "identity_anchor",
          type: "image",
          required: true,
          referenceRoles: ["identity_anchor"],
          target: { nodeId: "8", field: "image" },
        },
        {
          key: "identity_reference",
          type: "image",
          required: true,
          referenceRoles: ["identity_reference", "look_reference"],
          target: { nodeId: "12", field: "image" },
        },
      ],
    });

    expect(descriptor.identity.mode).toBe("multi_identity");
    expect(descriptor.inputs.filter((input) => input.type === "image")).toEqual([
      expect.objectContaining({
        key: "identity_anchor",
        required: true,
        referenceRoles: ["identity_anchor"],
      }),
      expect.objectContaining({
        key: "identity_reference",
        required: true,
        referenceRoles: ["identity_reference", "look_reference"],
      }),
    ]);
    expect(
      assignWorkflowReferenceSlots(
        descriptor,
        ["identity_reference", "identity_anchor"],
      ),
    ).toEqual({
      ok: true,
      assignments: [
        { slotKey: "identity_anchor", referenceIndex: 1 },
        { slotKey: "identity_reference", referenceIndex: 0 },
      ],
      minReferences: 2,
      maxReferences: 2,
    });
    expect(
      assignWorkflowReferenceSlots(
        descriptor,
        ["identity_anchor", "look_reference"],
      ),
    ).toEqual({
      ok: true,
      assignments: [
        { slotKey: "identity_anchor", referenceIndex: 0 },
        { slotKey: "identity_reference", referenceIndex: 1 },
      ],
      minReferences: 2,
      maxReferences: 2,
    });
    expect(
      assignWorkflowReferenceSlots(descriptor, ["identity_anchor"]),
    ).toMatchObject({
      ok: false,
      reason: "reference_cardinality_mismatch",
      minReferences: 2,
      maxReferences: 2,
    });
    expect(
      assignWorkflowReferenceSlots(
        descriptor,
        ["identity_anchor", "source_image"],
      ),
    ).toMatchObject({
      ok: false,
      reason: "reference_role_unsupported",
    });
  });

  it("rejects an incoherent source-plus-identity capability declaration", () => {
    expect(() => workflowDescriptorSchema.parse({
      workflowKey: "broken-source-identity",
      modelId: "identity-model",
      backendKind: "comfyui",
      comfyWorkflow: { id: "22222222-2222-4222-8222-222222222223", name: "Broken Identity Edit" },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "single_reference",
        maxReferences: 2,
        acceptedRoles: ["identity_anchor"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
      apiPrompt: {},
      inputs: [],
    })).toThrow("source_image");
  });

  it("requires every ComfyUI image slot to declare semantic reference roles", () => {
    expect(() => workflowDescriptorSchema.parse({
      workflowKey: "untyped-image-slot",
      modelId: "identity-model",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "22222222-2222-4222-8222-222222222224",
        name: "Untyped Image Slot",
      },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "single_reference",
        maxReferences: 1,
        acceptedRoles: ["source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: false,
      },
      apiPrompt: {
        "8": { class_type: "LoadImage", inputs: { image: "" } },
      },
      inputs: [
        {
          key: "source_image",
          type: "image",
          target: { nodeId: "8", field: "image" },
        },
      ],
    })).toThrow("accepted reference roles");
  });

  it("requires combined source and identity images to use distinct slots", () => {
    expect(() => workflowDescriptorSchema.parse({
      workflowKey: "mixed-image-slot",
      modelId: "identity-model",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "22222222-2222-4222-8222-222222222225",
        name: "Mixed Image Slot",
      },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "multi_reference",
        maxReferences: 2,
        acceptedRoles: ["identity_anchor", "source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
      apiPrompt: {
        "8": { class_type: "LoadImage", inputs: { image: "" } },
      },
      inputs: [
        {
          key: "mixed_image",
          type: "image",
          referenceRoles: ["identity_anchor", "source_image"],
          target: { nodeId: "8", field: "image" },
        },
      ],
    })).toThrow("distinct concrete slots");
  });

  it("rejects declared reference capacity that exceeds concrete ComfyUI image slots", () => {
    expect(() => workflowDescriptorSchema.parse({
      workflowKey: "drifted-reference-capacity",
      modelId: "identity-model",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "22222222-2222-4222-8222-222222222226",
        name: "Drifted Reference Capacity",
      },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "multi_reference",
        maxReferences: 4,
        acceptedRoles: ["identity_anchor", "source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
      apiPrompt: {
        "8": { class_type: "LoadImage", inputs: { image: "" } },
        "9": { class_type: "LoadImage", inputs: { image: "" } },
      },
      inputs: [
        {
          key: "identity_image",
          type: "image",
          referenceRoles: ["identity_anchor"],
          target: { nodeId: "8", field: "image" },
        },
        {
          key: "source_image",
          type: "image",
          referenceRoles: ["source_image"],
          target: { nodeId: "9", field: "image" },
        },
      ],
    })).toThrow("must equal the 2 declared semantic image slots");
  });

  it("rejects optional image slots until a graph-level onAbsent contract exists", () => {
    expect(() => workflowDescriptorSchema.parse({
      workflowKey: "optional-source",
      modelId: "identity-model",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "22222222-2222-4222-8222-222222222227",
        name: "Optional Source",
      },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "multi_reference",
        maxReferences: 2,
        acceptedRoles: ["identity_anchor", "source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
      apiPrompt: {
        "8": { class_type: "LoadImage", inputs: { image: "" } },
        "9": { class_type: "LoadImage", inputs: { image: "" } },
      },
      inputs: [
        {
          key: "identity_image",
          type: "image",
          referenceRoles: ["identity_anchor"],
          target: { nodeId: "8", field: "image" },
        },
        {
          key: "source_image",
          type: "image",
          referenceRoles: ["source_image"],
          required: false,
          target: { nodeId: "9", field: "image" },
        },
      ],
    })).toThrow("Optional image slots require an explicit graph-level onAbsent contract");
  });

  it("rejects duplicate slot keys and duplicate ComfyUI node-field targets", () => {
    const base = {
      workflowKey: "duplicate-slot-authority",
      modelId: "identity-model",
      backendKind: "comfyui",
      comfyWorkflow: {
        id: "22222222-2222-4222-8222-222222222228",
        name: "Duplicate Slot Authority",
      },
      version: 1,
      capabilities: ["referenceImages"],
      identity: {
        mode: "multi_reference",
        maxReferences: 2,
        acceptedRoles: ["identity_anchor", "source_image"],
        supportsLookReference: false,
        supportsSourceImageWithIdentity: true,
      },
      apiPrompt: {
        "8": { class_type: "LoadImage", inputs: { image: "" } },
        "9": { class_type: "LoadImage", inputs: { image: "" } },
      },
    } as const;
    expect(() => workflowDescriptorSchema.parse({
      ...base,
      inputs: [
        {
          key: "same_key",
          type: "image",
          referenceRoles: ["identity_anchor"],
          target: { nodeId: "8", field: "image" },
        },
        {
          key: "same_key",
          type: "image",
          referenceRoles: ["source_image"],
          target: { nodeId: "9", field: "image" },
        },
      ],
    })).toThrow("duplicates inputs[0].key");
    expect(() => workflowDescriptorSchema.parse({
      ...base,
      inputs: [
        {
          key: "identity_image",
          type: "image",
          referenceRoles: ["identity_anchor"],
          target: { nodeId: "8", field: "image" },
        },
        {
          key: "source_image",
          type: "image",
          referenceRoles: ["source_image"],
          target: { nodeId: "8", field: "image" },
        },
      ],
    })).toThrow("duplicates inputs[0].target");
  });
});

describe("workflow backend contracts", () => {
  it("accepts a Draw Things descriptor without a ComfyUI apiPrompt", () => {
    const descriptor = workflowDescriptorSchema.parse({
      workflowKey: "drawthings-pornmaster-t2i",
      modelId: "pornmaster-zimage-drawthings",
      backendKind: "drawthings",
      version: 1,
      capabilities: ["textToImage", "img2img", "stableSeed"],
      drawThings: { model: "pornmasterzimage_turbov35bf16_f16.ckpt" },
      inputs: [
        { key: "prompt", type: "text", target: { argFlag: "--prompt" } },
      ],
    });

    expect(descriptor.backendKind).toBe("drawthings");
    if (descriptor.backendKind !== "drawthings") throw new Error("expected Draw Things descriptor");
    expect(descriptor.drawThings.model).toBe("pornmasterzimage_turbov35bf16_f16.ckpt");
    expect("apiPrompt" in descriptor).toBe(false);
  });

  it("still requires apiPrompt for ComfyUI descriptors", () => {
    expect(() =>
      workflowDescriptorSchema.parse({
        workflowKey: "missing-comfy-prompt",
        modelId: "broken-comfy",
        backendKind: "comfyui",
        comfyWorkflow: { id: "33333333-3333-4333-8333-333333333333", name: "Missing Prompt" },
        version: 1,
        capabilities: ["textToImage"],
        inputs: [],
      }),
    ).toThrow();
  });

  it("requires stable ComfyUI workflow identity metadata", () => {
    expect(() =>
      workflowDescriptorSchema.parse({
        workflowKey: "missing-comfy-identity",
        modelId: "broken-comfy-identity",
        backendKind: "comfyui",
        version: 1,
        capabilities: ["textToImage"],
        apiPrompt: {},
        inputs: [],
      }),
    ).toThrow();
  });

  it("rejects node-bound inputs on Draw Things command workflows", () => {
    expect(() =>
      workflowDescriptorSchema.parse({
        workflowKey: "broken-drawthings",
        modelId: "broken-drawthings",
        backendKind: "drawthings",
        version: 1,
        capabilities: ["textToImage"],
        drawThings: { model: "model.ckpt" },
        inputs: [
          { key: "prompt", type: "text", target: { nodeId: "1", field: "text" } },
        ],
      }),
    ).toThrow();
  });

  it("rejects argument-bound inputs on ComfyUI graph workflows", () => {
    expect(() =>
      workflowDescriptorSchema.parse({
        workflowKey: "broken-comfy",
        modelId: "broken-comfy",
        backendKind: "comfyui",
        comfyWorkflow: { id: "44444444-4444-4444-8444-444444444444", name: "Broken Comfy" },
        version: 1,
        capabilities: ["textToImage"],
        apiPrompt: {},
        inputs: [
          { key: "prompt", type: "text", target: { argFlag: "--prompt" } },
        ],
      }),
    ).toThrow();
  });
});

describe("bindWorkflowArgs", () => {
  it("maps slots to command-backend arg flags", () => {
    const d = workflowDescriptorSchema.parse({
      workflowKey: "z-turbo-t2i", modelId: "z-turbo", backendKind: "drawthings", version: 1,
      capabilities: ["textToImage"], drawThings: { model: "z-turbo.ckpt" },
      inputs: [
        { key: "prompt", type: "text", target: { argFlag: "--prompt" } },
        { key: "steps", type: "int", target: { argFlag: "--steps" }, default: 8 },
      ],
    });
    expect(bindWorkflowArgs(d, { prompt: "hi" })).toEqual(["--prompt", "hi", "--steps", "8"]);
  });
});

describe("loadWorkflowDescriptors (opts.onSkip)", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("silently skips invalid files when no onSkip is passed", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shared-workflow-"));
    await writeFile(path.join(dir, "bad.json"), "{ not json");
    const descriptors = await loadWorkflowDescriptors(dir);
    expect(descriptors).toEqual([]);
  });

  it("reports invalid files via onSkip without throwing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shared-workflow-"));
    await writeFile(path.join(dir, "bad.json"), JSON.stringify({ not: "a descriptor" }));
    await writeFile(
      path.join(dir, "good.json"),
      JSON.stringify({
        workflowKey: "z-turbo-t2i", modelId: "z-turbo", backendKind: "drawthings", version: 1,
        capabilities: ["textToImage"], drawThings: { model: "z-turbo.ckpt" }, inputs: [],
      }),
    );
    const skipped: Array<{ file: string; err: string }> = [];
    const descriptors = await loadWorkflowDescriptors(dir, {
      onSkip: (file, err) => skipped.push({ file, err }),
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].modelId).toBe("z-turbo");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].file).toBe("bad.json");
  });
});
