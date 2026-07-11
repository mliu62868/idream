// SPEC: Workflow 描述符 = 图(apiPrompt) + 声明式输入槽。运营/上层只填槽，不碰 node id。
// INTENT: main/gen 共读的 SSoT（原 packages/gen/src/backend/workflow.ts 上移）。shared
// 不依赖 gen 的 pino logger，跳过无效文件时改为可选 onSkip 回调上报，默认静默跳过——
// 调用方（如 gen 的 registry.ts）自行决定是否记录/如何记录。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export type SlotValues = Record<string, string | number>;

const comfyNodeSchema = z.object({
  class_type: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});
export type ComfyNode = z.infer<typeof comfyNodeSchema>;

const slotSchema = z.object({
  key: z.string(),
  type: z.enum(["text", "int", "float", "image"]),
  target: z.union([
    z.object({ nodeId: z.string(), field: z.string() }),
    z.object({ argFlag: z.string() }),
  ]),
  default: z.union([z.string(), z.number()]).optional(),
});

export const workflowIdentityCapabilitySchema = z.object({
  mode: z.enum(["none", "single_reference", "multi_reference", "adapter", "multi_identity"]),
  maxReferences: z.number().int().min(0).max(16),
  acceptedRoles: z.array(z.enum(["identity_anchor", "identity_reference", "source_image"])),
  supportsLookReference: z.boolean(),
  supportsSourceImageWithIdentity: z.boolean(),
});

export const workflowQualityCapabilitySchema = z.object({
  maxCandidates: z.number().int().min(1).max(8),
  evaluatorDimensions: z.array(z.enum(["artifact", "face_count", "identity", "intent"])),
});

const workflowDescriptorBaseSchema = z.object({
  workflowKey: z.string(),
  modelId: z.string(),
  version: z.number().int().positive(),
  capabilities: z.array(z.string()),
  identity: workflowIdentityCapabilitySchema.default({
    mode: "none",
    maxReferences: 0,
    acceptedRoles: [],
    supportsLookReference: false,
    supportsSourceImageWithIdentity: false,
  }),
  quality: workflowQualityCapabilitySchema.default({
    maxCandidates: 1,
    evaluatorDimensions: ["artifact"],
  }),
  inputs: z.array(slotSchema),
});

const comfyWorkflowDescriptorSchema = workflowDescriptorBaseSchema.extend({
  backendKind: z.literal("comfyui"),
  apiPrompt: z.record(z.string(), comfyNodeSchema),
});

const sdcppWorkflowDescriptorSchema = workflowDescriptorBaseSchema.extend({
  backendKind: z.literal("sdcpp"),
  // Accepted for backward compatibility with descriptors created before the
  // backend-specific schema split. sd.cpp never reads this field.
  apiPrompt: z.record(z.string(), comfyNodeSchema).optional(),
});

const drawThingsWorkflowDescriptorSchema = workflowDescriptorBaseSchema.extend({
  backendKind: z.literal("drawthings"),
  drawThings: z.object({
    model: z.string().trim().min(1),
  }),
});

export const workflowDescriptorSchema = z.discriminatedUnion("backendKind", [
  comfyWorkflowDescriptorSchema,
  sdcppWorkflowDescriptorSchema,
  drawThingsWorkflowDescriptorSchema,
]);
export type WorkflowDescriptor = z.infer<typeof workflowDescriptorSchema>;

function resolveValue(slot: z.infer<typeof slotSchema>, values: SlotValues) {
  const v = values[slot.key] ?? slot.default;
  if (v === undefined) throw new Error(`missing required slot: ${slot.key}`);
  return v;
}

export function bindComfySlots(d: WorkflowDescriptor, values: SlotValues): Record<string, ComfyNode> {
  if (d.backendKind !== "comfyui") {
    throw new Error(`workflow ${d.workflowKey}: backend ${d.backendKind} has no ComfyUI prompt`);
  }
  const prompt = structuredClone(d.apiPrompt);
  for (const slot of d.inputs) {
    if (!("nodeId" in slot.target)) continue;
    const node = prompt[slot.target.nodeId];
    if (!node) throw new Error(`workflow ${d.workflowKey}: slot ${slot.key} targets missing node ${slot.target.nodeId}`);
    node.inputs[slot.target.field] = resolveValue(slot, values);
  }
  return prompt;
}

export function bindWorkflowArgs(d: WorkflowDescriptor, values: SlotValues): string[] {
  const args: string[] = [];
  for (const slot of d.inputs) {
    if (!("argFlag" in slot.target)) continue;
    args.push(slot.target.argFlag, String(resolveValue(slot, values)));
  }
  return args;
}

export function bindSdcppArgs(d: WorkflowDescriptor, values: SlotValues): string[] {
  return bindWorkflowArgs(d, values);
}

export async function loadWorkflowDescriptors(
  dir: string,
  opts?: { onSkip?: (file: string, err: string) => void },
): Promise<WorkflowDescriptor[]> {
  const out: WorkflowDescriptor[] = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(workflowDescriptorSchema.parse(JSON.parse(await readFile(path.join(dir, f), "utf8"))));
    } catch (err) {
      opts?.onSkip?.(f, String(err));
    }
  }
  return out;
}
