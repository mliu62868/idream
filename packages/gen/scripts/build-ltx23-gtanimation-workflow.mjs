import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [, , sourceArg, outputArg] = process.argv;
if (!sourceArg) {
  throw new Error(
    "Usage: node scripts/build-ltx23-gtanimation-workflow.mjs <api-prompt.json> [output.json]",
  );
}

const source = path.resolve(sourceArg);
const output = path.resolve(
  outputArg ?? "workflows/ltx23-gtanimation-i2v.json",
);
const apiPrompt = JSON.parse(await readFile(source, "utf8"));
if (
  apiPrompt?.["320:333"]?.inputs?.unet_name !==
  "ltx23Gtanimation25Frames_ltxv23INT4Convrot.safetensors"
) {
  throw new Error("Source prompt does not use the exact GTAnimation INT4 ConvRot checkpoint");
}
if (apiPrompt?.["75"]?.class_type !== "SaveVideo") {
  throw new Error("Source prompt does not contain the expected SaveVideo output");
}

apiPrompt["75"].inputs.filename_prefix = "idream-ltx23-gtanimation";
for (const node of Object.values(apiPrompt)) {
  if (node && typeof node === "object") delete node.is_changed;
}

const descriptor = {
  workflowKey: "ltx23-gtanimation-i2v",
  modelId: "ltx23-gtanimation-int4-convrot",
  backendKind: "comfyui",
  comfyWorkflow: {
    id: "9b3f4d6a-0c8e-4b72-9f51-2a6d7e8c9012",
    name: "iDream LTX 2.3 GTAnimation I2V",
  },
  version: 1,
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
    supportsLookReference: false,
    supportsSourceImageWithIdentity: false,
  },
  quality: {
    maxCandidates: 1,
    evaluatorDimensions: ["artifact", "identity", "intent"],
  },
  apiPrompt,
  inputs: [
    {
      key: "prompt",
      type: "text",
      target: { nodeId: "320:303", field: "text" },
    },
    {
      key: "negative",
      type: "text",
      target: { nodeId: "320:313", field: "text" },
    },
    {
      key: "source_image",
      type: "image",
      required: true,
      referenceRoles: ["source_image"],
      target: { nodeId: "269", field: "image" },
    },
    {
      key: "width",
      type: "int",
      default: 768,
      target: { nodeId: "320:312", field: "value" },
    },
    {
      key: "height",
      type: "int",
      default: 1152,
      target: { nodeId: "320:299", field: "value" },
    },
    {
      key: "fps",
      type: "int",
      default: 25,
      target: { nodeId: "320:300", field: "value" },
    },
    {
      key: "seconds",
      type: "int",
      default: 4,
      target: { nodeId: "320:301", field: "value" },
    },
    {
      key: "seed",
      type: "int",
      target: { nodeId: "320:277", field: "noise_seed" },
    },
    {
      key: "refinerSeed",
      type: "int",
      target: { nodeId: "320:276", field: "noise_seed" },
    },
  ],
};

await writeFile(output, `${JSON.stringify(descriptor, null, 2)}\n`);
console.log(output);
