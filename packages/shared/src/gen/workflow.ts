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

export const workflowDescriptorSchema = z.object({
  workflowKey: z.string(),
  modelId: z.string(),
  backendKind: z.enum(["comfyui", "sdcpp"]),
  version: z.number().int().positive(),
  capabilities: z.array(z.string()),
  apiPrompt: z.record(z.string(), comfyNodeSchema),
  inputs: z.array(slotSchema),
});
export type WorkflowDescriptor = z.infer<typeof workflowDescriptorSchema>;

function resolveValue(slot: z.infer<typeof slotSchema>, values: SlotValues) {
  const v = values[slot.key] ?? slot.default;
  if (v === undefined) throw new Error(`missing required slot: ${slot.key}`);
  return v;
}

export function bindComfySlots(d: WorkflowDescriptor, values: SlotValues): Record<string, ComfyNode> {
  const prompt = structuredClone(d.apiPrompt);
  for (const slot of d.inputs) {
    if (!("nodeId" in slot.target)) continue;
    const node = prompt[slot.target.nodeId];
    if (!node) throw new Error(`workflow ${d.workflowKey}: slot ${slot.key} targets missing node ${slot.target.nodeId}`);
    node.inputs[slot.target.field] = resolveValue(slot, values);
  }
  return prompt;
}

export function bindSdcppArgs(d: WorkflowDescriptor, values: SlotValues): string[] {
  const args: string[] = [];
  for (const slot of d.inputs) {
    if (!("argFlag" in slot.target)) continue;
    args.push(slot.target.argFlag, String(resolveValue(slot, values)));
  }
  return args;
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
