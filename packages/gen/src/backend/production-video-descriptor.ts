import { createHash } from "node:crypto";
import {
  characterVideoProductionRecipeForWorkflow,
  minimaxH3VideoProductionRecipe,
  redgraftLtx25VideoProductionRecipe,
  type CharacterVideoProductionRecipe,
} from "@idream/shared";
import type { WorkflowDescriptor } from "./workflow";

function ltxRuntimeInputs(recipe: CharacterVideoProductionRecipe) {
  return [
    { key: "prompt", type: "text", target: { nodeId: "320:303", field: "text" } },
    {
      key: "negative",
      type: "text",
      target: {
        nodeId: recipe.workflowKey === redgraftLtx25VideoProductionRecipe.workflowKey
          ? "900:0"
          : "320:313",
        field: "text",
      },
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
      default: recipe.width,
      target: { nodeId: "320:312", field: "value" },
    },
    {
      key: "height",
      type: "int",
      default: recipe.height,
      target: { nodeId: "320:299", field: "value" },
    },
    {
      key: "fps",
      type: "int",
      default: recipe.fps,
      target: { nodeId: "320:300", field: "value" },
    },
    {
      key: "seconds",
      type: "int",
      default: recipe.durationSeconds,
      target: { nodeId: "320:301", field: "value" },
    },
    { key: "seed", type: "int", target: { nodeId: "320:277", field: "noise_seed" } },
    { key: "refinerSeed", type: "int", target: { nodeId: "320:276", field: "noise_seed" } },
  ] as const;
}

const h3RuntimeInputs = [
  { key: "prompt", type: "text", target: { nodeId: "6", field: "prompt" } },
  {
    key: "source_image",
    type: "image",
    required: true,
    referenceRoles: ["source_image"],
    target: { nodeId: "16", field: "image" },
  },
  {
    key: "width",
    type: "int",
    default: minimaxH3VideoProductionRecipe.width,
    target: { nodeId: "6", field: "width" },
  },
  {
    key: "height",
    type: "int",
    default: minimaxH3VideoProductionRecipe.height,
    target: { nodeId: "6", field: "height" },
  },
  {
    key: "length",
    type: "int",
    default: minimaxH3VideoProductionRecipe.frameCount,
    target: { nodeId: "6", field: "length" },
  },
  {
    key: "fps",
    type: "int",
    default: minimaxH3VideoProductionRecipe.fps,
    target: { nodeId: "14", field: "fps" },
  },
  { key: "seed", type: "int", target: { nodeId: "7", field: "noise_seed" } },
] as const;

export function assertCharacterVideoProductionDescriptor(
  descriptor: WorkflowDescriptor,
): CharacterVideoProductionRecipe {
  const recipe = characterVideoProductionRecipeForWorkflow(
    descriptor.workflowKey,
  );
  if (
    !recipe ||
    descriptor.backendKind !== recipe.runner ||
    descriptor.modelId !== recipe.pipelineModel ||
    descriptor.version !== recipe.workflowVersion
  ) {
    throw new Error(
      `Workflow ${descriptor.workflowKey}@${descriptor.version} is not an authorized production video recipe`,
    );
  }
  const runtimeInputs = runtimeInputsForRecipe(recipe);
  if (stableJson(descriptor.inputs) !== stableJson(runtimeInputs)) {
    throw new Error("Production video runtime input bindings do not match the immutable recipe");
  }

  const graph = executableGraph(descriptor);
  if (
    recipe.workflowKey === minimaxH3VideoProductionRecipe.workflowKey
  ) {
    assertH3Graph(graph);
  } else {
    assertLtxGraph(graph, recipe);
  }

  const fingerprint = characterVideoProductionDescriptorFingerprint(descriptor);
  if (fingerprint !== recipe.workflowGraphSha256) {
    throw new Error(
      `Production video workflow graph fingerprint ${fingerprint} does not match the immutable recipe`,
    );
  }
  return recipe;
}

export function characterVideoProductionDescriptorFingerprint(
  descriptor: WorkflowDescriptor,
): string {
  if (descriptor.backendKind !== "comfyui") {
    throw new Error("Production video workflow must use ComfyUI");
  }
  const recipe = characterVideoProductionRecipeForWorkflow(
    descriptor.workflowKey,
  );
  if (!recipe) {
    throw new Error(
      `Workflow ${descriptor.workflowKey} is not an authorized production video recipe`,
    );
  }
  const graph = executableGraph(descriptor);
  for (const input of runtimeInputsForRecipe(recipe)) {
    const node = graph[input.target.nodeId];
    const inputs = recordValue(node?.inputs);
    if (!node || !Object.hasOwn(inputs, input.target.field)) {
      throw new Error(
        `Production video runtime input ${input.key} targets a missing graph field`,
      );
    }
    inputs[input.target.field] = `<runtime:${input.key}>`;
    node.inputs = inputs;
  }
  return createHash("sha256")
    .update(stableJson({
      workflowKey: descriptor.workflowKey,
      modelId: descriptor.modelId,
      backendKind: descriptor.backendKind,
      comfyWorkflow: descriptor.comfyWorkflow,
      version: descriptor.version,
      capabilities: descriptor.capabilities,
      identity: descriptor.identity,
      quality: descriptor.quality ?? null,
      inputs: descriptor.inputs,
      apiPrompt: graph,
    }))
    .digest("hex");
}

function runtimeInputsForRecipe(recipe: CharacterVideoProductionRecipe) {
  return recipe.workflowKey === minimaxH3VideoProductionRecipe.workflowKey
    ? h3RuntimeInputs
    : ltxRuntimeInputs(recipe);
}

function assertLtxGraph(
  graph: Record<string, Record<string, unknown>>,
  recipe: CharacterVideoProductionRecipe,
) {
  assertGraphValue(graph, "320:333", "class_type", "UNETLoader");
  assertGraphInput(graph, "320:333", "unet_name", recipe.checkpointFilename);
  assertGraphValue(graph, "75", "class_type", "SaveVideo");
  assertGraphInput(graph, "75", "filename_prefix", recipe.outputFilenamePrefix);
  for (const nodeId of ["320:280", "320:291"] as const) {
    assertGraphValue(graph, nodeId, "class_type", "KSamplerSelect");
    assertGraphInput(graph, nodeId, "sampler_name", recipe.sampler);
  }
  for (const nodeId of ["320:282", "320:314"] as const) {
    assertGraphValue(graph, nodeId, "class_type", "CFGGuider");
    assertGraphInput(graph, nodeId, "cfg", recipe.cfgScale);
  }
  if (recipe.scheduler !== "manual_sigmas") {
    throw new Error("Production LTX video recipe requires manual sigma scheduling");
  }
  const sigmaSteps = ["320:281", "320:306"].reduce((total, nodeId) => {
    assertGraphValue(graph, nodeId, "class_type", "ManualSigmas");
    const value = graphInput(graph, nodeId, "sigmas");
    if (typeof value !== "string") {
      throw new Error(`Production video node ${nodeId}.inputs.sigmas is invalid`);
    }
    return total + value.split(",").map((part) => part.trim()).filter(Boolean).length;
  }, 0);
  if (sigmaSteps !== recipe.steps) {
    throw new Error(
      `Production video sigma schedule has ${sigmaSteps} steps; expected ${recipe.steps}`,
    );
  }
}

function assertH3Graph(
  graph: Record<string, Record<string, unknown>>,
) {
  const recipe = minimaxH3VideoProductionRecipe;
  assertGraphValue(graph, "1", "class_type", "UNETLoader");
  assertGraphInput(graph, "1", "unet_name", recipe.checkpointFilename);
  assertGraphValue(graph, "2", "class_type", "MiniMaxH3SigmaShift");
  if (graph["17"] !== undefined) {
    throw new Error("Production H3 graph must keep exact attention at 512x512");
  }
  assertGraphInput(graph, "2", "model", ["1", 0]);
  assertGraphInput(graph, "2", "shift_video", recipe.shiftVideo);
  assertGraphInput(graph, "2", "shift_audio", recipe.shiftAudio);
  assertGraphValue(graph, "3", "class_type", "CLIPLoaderGGUF");
  assertGraphInput(graph, "3", "clip_name", recipe.textEncoderFilename);
  assertGraphInput(graph, "3", "type", "minimax");
  assertGraphValue(graph, "4", "class_type", "VAELoader");
  assertGraphInput(graph, "4", "vae_name", recipe.videoVaeFilename);
  assertGraphValue(graph, "5", "class_type", "VAELoader");
  assertGraphInput(graph, "5", "vae_name", recipe.audioVaeFilename);
  assertGraphValue(graph, "6", "class_type", "MiniMaxH3ImageToVideo");
  assertGraphValue(graph, "8", "class_type", "KSamplerSelect");
  assertGraphInput(graph, "8", "sampler_name", recipe.sampler);
  assertGraphValue(graph, "9", "class_type", "BasicScheduler");
  assertGraphInput(graph, "9", "scheduler", recipe.scheduler);
  assertGraphInput(graph, "9", "steps", recipe.steps);
  assertGraphInput(graph, "9", "denoise", 1);
  assertGraphValue(graph, "10", "class_type", "BasicGuider");
  assertGraphValue(graph, "14", "class_type", "CreateVideo");
  assertGraphInput(graph, "14", "bit_depth", 8);
  assertGraphValue(graph, "15", "class_type", "SaveVideo");
  assertGraphInput(graph, "15", "filename_prefix", recipe.outputFilenamePrefix);
}

function executableGraph(descriptor: WorkflowDescriptor) {
  if (descriptor.backendKind !== "comfyui") {
    throw new Error("Production video workflow must use ComfyUI");
  }
  const graph = structuredClone(descriptor.apiPrompt) as Record<
    string,
    Record<string, unknown>
  >;
  for (const node of Object.values(graph)) {
    delete node._meta;
    delete node.is_changed;
  }
  return graph;
}

function assertGraphValue(
  graph: Record<string, Record<string, unknown>>,
  nodeId: string,
  field: string,
  expected: unknown,
) {
  if (graph[nodeId]?.[field] !== expected) {
    throw new Error(`Production video node ${nodeId}.${field} does not match the recipe`);
  }
}

function assertGraphInput(
  graph: Record<string, Record<string, unknown>>,
  nodeId: string,
  field: string,
  expected: unknown,
) {
  if (stableJson(graphInput(graph, nodeId, field)) !== stableJson(expected)) {
    throw new Error(
      `Production video node ${nodeId}.inputs.${field} does not match the recipe`,
    );
  }
}

function graphInput(
  graph: Record<string, Record<string, unknown>>,
  nodeId: string,
  field: string,
) {
  return recordValue(graph[nodeId]?.inputs)[field];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}
