import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  workflowDescriptorSchema,
  bindComfySlots,
  bindSdcppArgs,
  loadWorkflowDescriptors,
} from "./workflow";

// Resolve packages/gen/workflows relative to this test file (not process.cwd()),
// so the test works regardless of which directory vitest is invoked from.
const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../workflows",
);

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

describe("loadWorkflowDescriptors (real files on disk)", () => {
  it("loads the redcraft-krea2 txt2img descriptor and validates it against the schema", async () => {
    const descriptors = await loadWorkflowDescriptors(WORKFLOWS_DIR);
    // The dir also contains a legacy non-conforming file
    // (redcraft-krea2-comfyui-text.json) which the loader warn-skips —
    // so we assert presence of the target modelId, not array length.
    const redcraft = descriptors.find((d) => d.modelId === "redcraft-krea2-comfyui");
    expect(redcraft).toBeDefined();
    expect(() => workflowDescriptorSchema.parse(redcraft)).not.toThrow();
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
