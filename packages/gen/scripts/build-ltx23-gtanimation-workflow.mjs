import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { characterVideoProductionRecipe } from "@idream/shared";
import { assertCharacterVideoProductionDescriptor } from "../src/backend/production-video-descriptor.ts";

const [, , sourceArg, outputArg] = process.argv;
if (!sourceArg) {
  throw new Error(
    "Usage: bun scripts/build-ltx23-gtanimation-workflow.mjs <api-prompt.json> [output.json]",
  );
}

const source = path.resolve(sourceArg);
const output = path.resolve(
  outputArg ?? "workflows/ltx23-gtanimation-i2v.json",
);
const apiPrompt = JSON.parse(await readFile(source, "utf8"));
apiPrompt["75"].inputs.filename_prefix =
  characterVideoProductionRecipe.outputFilenamePrefix;
for (const node of Object.values(apiPrompt)) {
  if (node && typeof node === "object") delete node.is_changed;
}

const descriptor = {
  workflowKey: characterVideoProductionRecipe.workflowKey,
  modelId: characterVideoProductionRecipe.pipelineModel,
  backendKind: characterVideoProductionRecipe.runner,
  comfyWorkflow: {
    id: characterVideoProductionRecipe.comfyWorkflowId,
    name: characterVideoProductionRecipe.comfyWorkflowName,
  },
  version: characterVideoProductionRecipe.workflowVersion,
  capabilities: characterVideoProductionRecipe.capabilities,
  identity: {
    mode: "single_reference",
    maxReferences: 1,
    acceptedRoles: ["source_image"],
    supportsLookReference: false,
    supportsSourceImageWithIdentity: false,
  },
  quality: {
    maxCandidates: characterVideoProductionRecipe.outputCount,
    evaluatorDimensions: characterVideoProductionRecipe.evaluatorDimensions,
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
      default: characterVideoProductionRecipe.width,
      target: { nodeId: "320:312", field: "value" },
    },
    {
      key: "height",
      type: "int",
      default: characterVideoProductionRecipe.height,
      target: { nodeId: "320:299", field: "value" },
    },
    {
      key: "fps",
      type: "int",
      default: characterVideoProductionRecipe.fps,
      target: { nodeId: "320:300", field: "value" },
    },
    {
      key: "seconds",
      type: "int",
      default: characterVideoProductionRecipe.durationSeconds,
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

assertCharacterVideoProductionDescriptor(descriptor);

await writeFile(output, `${JSON.stringify(descriptor, null, 2)}\n`);
console.log(output);
