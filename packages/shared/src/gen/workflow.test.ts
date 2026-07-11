import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  workflowDescriptorSchema,
  bindComfySlots,
  bindSdcppArgs,
  loadWorkflowDescriptors,
} from "./workflow";

const comfyDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "t2i",
  modelId: "redcraft-krea2-comfyui",
  backendKind: "comfyui",
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
});

describe("workflow identity capability contract", () => {
  it("parses an explicit identity-routing and quality contract", () => {
    const descriptor = workflowDescriptorSchema.parse({
      workflowKey: "identity-edit",
      modelId: "identity-model",
      backendKind: "comfyui",
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
      apiPrompt: {},
      inputs: [],
    });

    expect(descriptor.identity).toMatchObject({
      mode: "single_reference",
      maxReferences: 1,
      acceptedRoles: ["identity_anchor", "source_image"],
    });
    expect(descriptor.quality.evaluatorDimensions).toEqual(["artifact", "identity", "intent"]);
  });
});

describe("bindSdcppArgs", () => {
  it("maps slots to sd-cli arg flags", () => {
    const d = workflowDescriptorSchema.parse({
      workflowKey: "sd", modelId: "z-turbo", backendKind: "sdcpp", version: 1,
      capabilities: ["textToImage"], apiPrompt: {},
      inputs: [
        { key: "prompt", type: "text", target: { argFlag: "--prompt" } },
        { key: "steps", type: "int", target: { argFlag: "--steps" }, default: 8 },
      ],
    });
    expect(bindSdcppArgs(d, { prompt: "hi" })).toEqual(["--prompt", "hi", "--steps", "8"]);
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
        workflowKey: "sd", modelId: "z-turbo", backendKind: "sdcpp", version: 1,
        capabilities: ["textToImage"], apiPrompt: {}, inputs: [],
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
