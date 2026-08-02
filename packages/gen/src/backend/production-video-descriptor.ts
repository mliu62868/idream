import { createHash } from "node:crypto";
import { characterVideoProductionRecipe } from "@idream/shared";
import type { WorkflowDescriptor } from "./workflow";

const runtimeInputs = [
  { key: "prompt", type: "text", target: { nodeId: "320:303", field: "text" } },
  { key: "negative", type: "text", target: { nodeId: "320:313", field: "text" } },
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
  { key: "seed", type: "int", target: { nodeId: "320:277", field: "noise_seed" } },
  { key: "refinerSeed", type: "int", target: { nodeId: "320:276", field: "noise_seed" } },
] as const;

export function assertCharacterVideoProductionDescriptor(
  descriptor: WorkflowDescriptor,
): void {
  if (
    descriptor.backendKind !== characterVideoProductionRecipe.runner ||
    descriptor.workflowKey !== characterVideoProductionRecipe.workflowKey ||
    descriptor.modelId !== characterVideoProductionRecipe.pipelineModel ||
    descriptor.version !== characterVideoProductionRecipe.workflowVersion
  ) {
    throw new Error(
      `Only ${characterVideoProductionRecipe.workflowKey}@${characterVideoProductionRecipe.workflowVersion} with ${characterVideoProductionRecipe.pipelineModel} is authorized for production video`,
    );
  }
  if (stableJson(descriptor.inputs) !== stableJson(runtimeInputs)) {
    throw new Error("Production video runtime input bindings do not match the immutable recipe");
  }

  const graph = executableGraph(descriptor);
  assertGraphValue(graph, "320:333", "class_type", "UNETLoader");
  assertGraphInput(
    graph,
    "320:333",
    "unet_name",
    characterVideoProductionRecipe.checkpointFilename,
  );
  assertGraphValue(graph, "75", "class_type", "SaveVideo");
  assertGraphInput(
    graph,
    "75",
    "filename_prefix",
    characterVideoProductionRecipe.outputFilenamePrefix,
  );
  for (const nodeId of ["320:280", "320:291"] as const) {
    assertGraphValue(graph, nodeId, "class_type", "KSamplerSelect");
    assertGraphInput(
      graph,
      nodeId,
      "sampler_name",
      characterVideoProductionRecipe.sampler,
    );
  }
  for (const nodeId of ["320:282", "320:314"] as const) {
    assertGraphValue(graph, nodeId, "class_type", "CFGGuider");
    assertGraphInput(
      graph,
      nodeId,
      "cfg",
      characterVideoProductionRecipe.cfgScale,
    );
  }
  if (characterVideoProductionRecipe.scheduler !== "manual_sigmas") {
    throw new Error("Production video recipe requires manual sigma scheduling");
  }
  const sigmaSteps = ["320:281", "320:306"].reduce((total, nodeId) => {
    assertGraphValue(graph, nodeId, "class_type", "ManualSigmas");
    const value = graphInput(graph, nodeId, "sigmas");
    if (typeof value !== "string") {
      throw new Error(`Production video node ${nodeId}.inputs.sigmas is invalid`);
    }
    return total + value.split(",").map((part) => part.trim()).filter(Boolean).length;
  }, 0);
  if (sigmaSteps !== characterVideoProductionRecipe.steps) {
    throw new Error(
      `Production video sigma schedule has ${sigmaSteps} steps; expected ${characterVideoProductionRecipe.steps}`,
    );
  }

  const fingerprint = characterVideoProductionDescriptorFingerprint(descriptor);
  if (fingerprint !== characterVideoProductionRecipe.workflowGraphSha256) {
    throw new Error(
      `Production video workflow graph fingerprint ${fingerprint} does not match the immutable recipe`,
    );
  }
}

export function characterVideoProductionDescriptorFingerprint(
  descriptor: WorkflowDescriptor,
): string {
  if (descriptor.backendKind !== "comfyui") {
    throw new Error("Production video workflow must use ComfyUI");
  }
  const graph = executableGraph(descriptor);
  for (const input of runtimeInputs) {
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
  if (graphInput(graph, nodeId, field) !== expected) {
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
