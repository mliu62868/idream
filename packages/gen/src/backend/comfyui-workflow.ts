import type { WorkflowDescriptor } from "./workflow";

type JsonRecord = Record<string, unknown>;
type ComfyDescriptor = Extract<WorkflowDescriptor, { backendKind: "comfyui" }>;

type ObjectInfo = {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  input_order?: {
    required?: string[];
    optional?: string[];
  };
  output?: string[];
  output_name?: string[];
};

type UiInput = {
  name: string;
  type: string;
  link: number | null;
  widget?: { name: string };
};

type UiOutput = {
  name: string;
  type: string;
  links: number[] | null;
};

type UiNodeDraft = {
  id: number;
  type: string;
  inputs: UiInput[];
  outputs: UiOutput[];
  widgetsValues: unknown[];
};

export async function syncComfyUiWorkflow(input: {
  apiUrl: string;
  descriptor: ComfyDescriptor;
  timeoutMs: number;
}): Promise<JsonRecord> {
  const apiUrl = input.apiUrl.replace(/\/+$/, "");
  const objectInfoResponse = await fetchWithTimeout(`${apiUrl}/object_info`, {}, input.timeoutMs);
  if (!objectInfoResponse.ok) {
    throw new Error(`ComfyUI /object_info HTTP ${objectInfoResponse.status}`);
  }
  const objectInfo = (await objectInfoResponse.json()) as Record<string, ObjectInfo>;
  const workflow = buildComfyUiWorkflow(input.descriptor, objectInfo);
  const filename = `${sanitizeWorkflowName(input.descriptor.comfyWorkflow.name)}.json`;
  const userDataPath = encodeURIComponent(`workflows/${filename}`);
  const saveResponse = await fetchWithTimeout(
    `${apiUrl}/userdata/${userDataPath}?overwrite=true`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workflow),
    },
    input.timeoutMs,
  );
  if (!saveResponse.ok) {
    throw new Error(`ComfyUI workflow save HTTP ${saveResponse.status}`);
  }
  return workflow;
}

export function buildComfyUiWorkflow(
  descriptor: ComfyDescriptor,
  objectInfo: Record<string, ObjectInfo>,
): JsonRecord {
  const drafts = new Map<string, UiNodeDraft>();
  const promptEntries = Object.entries(descriptor.apiPrompt);

  for (const [nodeId, promptNode] of promptEntries) {
    const info = objectInfo[promptNode.class_type];
    if (!info) throw new Error(`ComfyUI object_info is missing node type ${promptNode.class_type}`);
    const definitions = { ...info.input?.required, ...info.input?.optional };
    const orderedNames = orderedInputNames(info, definitions);
    const inputDrafts = orderedNames.map((name) => {
      const definition = definitions[name];
      const value = promptNode.inputs[name];
      return {
        name,
        type: inputType(definition),
        definition,
        value,
        widget: isWidgetInput(definition, value),
      };
    });
    inputDrafts.sort((a, b) => Number(a.widget) - Number(b.widget));

    const inputs: UiInput[] = inputDrafts.map((input) => ({
      name: input.name,
      type: input.type,
      link: null,
      ...(input.widget ? { widget: { name: input.name } } : {}),
    }));
    const widgetsValues: unknown[] = [];
    for (const input of inputDrafts) {
      if (!input.widget) continue;
      widgetsValues.push(input.value ?? inputDefault(input.definition));
      if (inputOptions(input.definition).control_after_generate === true) {
        widgetsValues.push("fixed");
      }
    }
    const outputTypes = info.output ?? [];
    const outputNames = info.output_name ?? outputTypes;
    drafts.set(nodeId, {
      id: numericNodeId(nodeId),
      type: promptNode.class_type,
      inputs,
      outputs: outputTypes.map((type, index) => ({
        name: outputNames[index] ?? type,
        type,
        links: null,
      })),
      widgetsValues,
    });
  }

  const links: Array<[number, number, number, number, number, string]> = [];
  let linkId = 0;
  for (const [targetId, promptNode] of promptEntries) {
    const target = drafts.get(targetId);
    if (!target) continue;
    for (const [inputName, value] of Object.entries(promptNode.inputs)) {
      if (!isConnection(value)) continue;
      const sourceId = String(value[0]);
      const sourceOutputIndex = value[1];
      const source = drafts.get(sourceId);
      const targetInputIndex = target.inputs.findIndex((input) => input.name === inputName);
      const sourceOutput = source?.outputs[sourceOutputIndex];
      if (!source || !sourceOutput || targetInputIndex < 0) {
        throw new Error(`invalid ComfyUI link ${sourceId}:${sourceOutputIndex} -> ${targetId}:${inputName}`);
      }
      linkId += 1;
      target.inputs[targetInputIndex].link = linkId;
      sourceOutput.links ??= [];
      sourceOutput.links.push(linkId);
      links.push([linkId, source.id, sourceOutputIndex, target.id, targetInputIndex, sourceOutput.type]);
    }
  }

  const positions = layoutPositions(descriptor);
  const nodes = promptEntries.map(([nodeId], index) => {
    const node = drafts.get(nodeId);
    if (!node) throw new Error(`missing ComfyUI UI node ${nodeId}`);
    return {
      id: node.id,
      type: node.type,
      pos: positions.get(nodeId) ?? [0, index * 260],
      size: [320, Math.max(140, 90 + node.inputs.length * 28)],
      flags: {},
      order: index,
      mode: 0,
      inputs: node.inputs,
      outputs: node.outputs,
      properties: { "Node name for S&R": node.type },
      widgets_values: node.widgetsValues,
    };
  });

  return {
    id: descriptor.comfyWorkflow.id,
    revision: descriptor.version - 1,
    last_node_id: Math.max(...nodes.map((node) => node.id), 0),
    last_link_id: linkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: {
      ds: { scale: 0.8, offset: [120, 120] },
      idream: {
        name: descriptor.comfyWorkflow.name,
        workflowKey: descriptor.workflowKey,
        modelId: descriptor.modelId,
        version: descriptor.version,
      },
    },
    version: 0.4,
  };
}

function orderedInputNames(info: ObjectInfo, definitions: Record<string, unknown>): string[] {
  const declared = [
    ...(info.input_order?.required ?? Object.keys(info.input?.required ?? {})),
    ...(info.input_order?.optional ?? Object.keys(info.input?.optional ?? {})),
  ];
  return [...new Set([...declared, ...Object.keys(definitions)])];
}

function inputType(definition: unknown): string {
  if (!Array.isArray(definition)) return "*";
  return Array.isArray(definition[0]) ? "COMBO" : String(definition[0] ?? "*");
}

function inputOptions(definition: unknown): JsonRecord {
  if (!Array.isArray(definition) || !definition[1] || typeof definition[1] !== "object") return {};
  return definition[1] as JsonRecord;
}

function inputDefault(definition: unknown): unknown {
  const options = inputOptions(definition);
  if (options.default !== undefined) return options.default;
  if (Array.isArray(definition) && Array.isArray(definition[0])) return definition[0][0] ?? "";
  return "";
}

function isWidgetInput(definition: unknown, value: unknown): boolean {
  if (isConnection(value)) return false;
  const type = inputType(definition);
  return type === "COMBO" || ["STRING", "INT", "FLOAT", "BOOLEAN"].includes(type);
}

function isConnection(value: unknown): value is [string | number, number] {
  return Array.isArray(value)
    && value.length === 2
    && (typeof value[0] === "string" || typeof value[0] === "number")
    && typeof value[1] === "number";
}

function numericNodeId(nodeId: string): number {
  const value = Number(nodeId);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`ComfyUI UI workflow requires numeric node id: ${nodeId}`);
  return value;
}

function layoutPositions(descriptor: ComfyDescriptor): Map<string, [number, number]> {
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFor = (nodeId: string): number => {
    const cached = depths.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const node = descriptor.apiPrompt[nodeId];
    const sourceDepths = Object.values(node?.inputs ?? {})
      .filter(isConnection)
      .map((value) => depthFor(String(value[0])) + 1);
    visiting.delete(nodeId);
    const depth = Math.max(0, ...sourceDepths);
    depths.set(nodeId, depth);
    return depth;
  };
  for (const nodeId of Object.keys(descriptor.apiPrompt)) depthFor(nodeId);
  const rows = new Map<number, number>();
  const positions = new Map<string, [number, number]>();
  for (const nodeId of Object.keys(descriptor.apiPrompt)) {
    const depth = depths.get(nodeId) ?? 0;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    positions.set(nodeId, [depth * 420, row * 300]);
  }
  return positions;
}

function sanitizeWorkflowName(name: string): string {
  return name.replaceAll(/[/\\:]/g, "_").slice(0, 200).trim();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
