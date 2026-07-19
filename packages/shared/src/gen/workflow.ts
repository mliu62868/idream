// SPEC: Workflow 描述符 = 图(apiPrompt) + 声明式输入槽。运营/上层只填槽，不碰 node id。
// INTENT: main/gen 共读的 SSoT（原 packages/gen/src/backend/workflow.ts 上移）。shared
// 不依赖 gen 的 pino logger，跳过无效文件时改为可选 onSkip 回调上报，默认静默跳过——
// 调用方（如 gen 的 registry.ts）自行决定是否记录/如何记录。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export type SlotValues = Record<string, string | number>;

export const workflowBackendKinds = ["comfyui", "sdcpp", "drawthings"] as const;
export const workflowBackendKindSchema = z.enum(workflowBackendKinds);
export type WorkflowBackendKind = z.infer<typeof workflowBackendKindSchema>;

const comfyNodeSchema = z.object({
  class_type: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});
export type ComfyNode = z.infer<typeof comfyNodeSchema>;

const slotBaseSchema = z.object({
  key: z.string(),
  type: z.enum(["text", "int", "float", "image"]),
  default: z.union([z.string(), z.number()]).optional(),
});

export const workflowReferenceRoleSchema = z.enum([
  "identity_anchor",
  "identity_reference",
  "look_reference",
  "source_image",
]);
export type WorkflowReferenceRole = z.infer<typeof workflowReferenceRoleSchema>;

const comfySlotSchema = slotBaseSchema.extend({
  target: z.object({ nodeId: z.string(), field: z.string() }),
  additionalTargets: z
    .array(z.object({ nodeId: z.string(), field: z.string() }))
    .min(1)
    .optional(),
  referenceRoles: z.array(workflowReferenceRoleSchema).min(1).optional(),
  // Reserved for a future graph-level onAbsent contract. `false` is rejected
  // below because leaving a LoadImage value untouched is not executable
  // optionality.
  required: z.boolean().optional(),
});

const commandSlotSchema = slotBaseSchema.extend({
  target: z.object({ argFlag: z.string() }),
});

type WorkflowSlot = z.infer<typeof comfySlotSchema> | z.infer<typeof commandSlotSchema>;

export const workflowIdentityCapabilitySchema = z.object({
  mode: z.enum(["none", "single_reference", "multi_reference", "adapter", "multi_identity"]),
  maxReferences: z.number().int().min(0).max(16),
  acceptedRoles: z.array(workflowReferenceRoleSchema),
  supportsLookReference: z.boolean(),
  supportsSourceImageWithIdentity: z.boolean(),
}).superRefine((contract, context) => {
  if (
    contract.supportsLookReference !==
      contract.acceptedRoles.includes("look_reference")
  ) {
    context.addIssue({
      code: "custom",
      path: ["supportsLookReference"],
      message:
        "supportsLookReference must exactly match acceptance of the look_reference role",
    });
  }
  if (!contract.supportsSourceImageWithIdentity) return;
  if (!contract.acceptedRoles.includes("source_image")) {
    context.addIssue({
      code: "custom",
      path: ["acceptedRoles"],
      message: "source+identity workflows must accept the source_image role",
    });
  }
  if (!contract.acceptedRoles.some((role) => role === "identity_anchor" || role === "identity_reference")) {
    context.addIssue({
      code: "custom",
      path: ["acceptedRoles"],
      message: "source+identity workflows must accept an identity role",
    });
  }
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
});

const comfyWorkflowDescriptorSchema = workflowDescriptorBaseSchema.extend({
  backendKind: z.literal("comfyui"),
  comfyWorkflow: z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1),
  }),
  apiPrompt: z.record(z.string(), comfyNodeSchema),
  inputs: z.array(comfySlotSchema),
});

const sdcppWorkflowDescriptorSchema = workflowDescriptorBaseSchema.extend({
  backendKind: z.literal("sdcpp"),
  // Accepted for backward compatibility with descriptors created before the
  // backend-specific schema split. sd.cpp never reads this field.
  apiPrompt: z.record(z.string(), comfyNodeSchema).optional(),
  inputs: z.array(commandSlotSchema),
});

const drawThingsWorkflowDescriptorSchema = workflowDescriptorBaseSchema.extend({
  backendKind: z.literal("drawthings"),
  drawThings: z.object({
    model: z.string().trim().min(1),
  }),
  inputs: z.array(commandSlotSchema),
});

export const workflowDescriptorSchema = z.discriminatedUnion("backendKind", [
  comfyWorkflowDescriptorSchema,
  sdcppWorkflowDescriptorSchema,
  drawThingsWorkflowDescriptorSchema,
]).superRefine((descriptor, context) => {
  const inputIndexByKey = new Map<string, number>();
  for (const [index, slot] of descriptor.inputs.entries()) {
    const previousIndex = inputIndexByKey.get(slot.key);
    if (previousIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["inputs", index, "key"],
        message:
          `Workflow input key ${slot.key} duplicates inputs[${previousIndex}].key`,
      });
    } else {
      inputIndexByKey.set(slot.key, index);
    }
  }
  if (descriptor.backendKind !== "comfyui") return;
  const imageSlots = descriptor.inputs.filter((slot) => slot.type === "image");
  const inputPathByTarget = new Map<string, string>();
  if (descriptor.identity.maxReferences !== imageSlots.length) {
    context.addIssue({
      code: "custom",
      path: ["identity", "maxReferences"],
      message:
        `ComfyUI identity.maxReferences must equal the ${imageSlots.length} declared semantic image slots`,
    });
  }
  if (
    descriptor.identity.mode === "none" &&
    (imageSlots.length !== 0 || descriptor.identity.acceptedRoles.length !== 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["identity", "mode"],
      message: "ComfyUI workflows with identity mode none cannot declare reference image authority",
    });
  }
  if (
    imageSlots.length > 0 &&
    !descriptor.capabilities.includes("referenceImages")
  ) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: "ComfyUI workflows with image slots must declare referenceImages capability",
    });
  }
  for (const [index, slot] of descriptor.inputs.entries()) {
    const targets = [slot.target, ...(slot.additionalTargets ?? [])];
    for (const [targetIndex, target] of targets.entries()) {
      const targetPath = targetIndex === 0
        ? `inputs[${index}].target`
        : `inputs[${index}].additionalTargets[${targetIndex - 1}]`;
      const issuePath = targetIndex === 0
        ? ["inputs", index, "target"]
        : ["inputs", index, "additionalTargets", targetIndex - 1];
      const targetKey = `${target.nodeId}\u0000${target.field}`;
      const previousTargetPath = inputPathByTarget.get(targetKey);
      if (previousTargetPath !== undefined) {
        context.addIssue({
          code: "custom",
          path: issuePath,
          message:
            `ComfyUI target ${target.nodeId}.${target.field} duplicates ${previousTargetPath}`,
        });
      } else {
        inputPathByTarget.set(targetKey, targetPath);
      }
      const targetNode = descriptor.apiPrompt[target.nodeId];
      if (!targetNode) {
        context.addIssue({
          code: "custom",
          path: [...issuePath, "nodeId"],
          message: `ComfyUI input targets missing node ${target.nodeId}`,
        });
      } else if (!Object.hasOwn(targetNode.inputs, target.field)) {
        context.addIssue({
          code: "custom",
          path: [...issuePath, "field"],
          message:
            `ComfyUI input targets missing field ${target.nodeId}.${target.field}`,
        });
      }
    }
    if (slot.type !== "image" && slot.required !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["inputs", index, "required"],
        message: "required may only be declared on image slots",
      });
    }
    if (slot.type !== "image" && slot.referenceRoles !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["inputs", index, "referenceRoles"],
        message: "referenceRoles may only be declared on image slots",
      });
      continue;
    }
    if (slot.type !== "image") continue;
    if (slot.required === false) {
      context.addIssue({
        code: "custom",
        path: ["inputs", index, "required"],
        message:
          "Optional image slots require an explicit graph-level onAbsent contract and are not supported",
      });
    }
    if (!slot.referenceRoles?.length) {
      context.addIssue({
        code: "custom",
        path: ["inputs", index, "referenceRoles"],
        message: "ComfyUI image slots must declare their accepted reference roles",
      });
      continue;
    }
    if (new Set(slot.referenceRoles).size !== slot.referenceRoles.length) {
      context.addIssue({
        code: "custom",
        path: ["inputs", index, "referenceRoles"],
        message: "ComfyUI image slot reference roles must be unique",
      });
    }
    const unsupportedRole = slot.referenceRoles.find(
      (role) => !descriptor.identity.acceptedRoles.includes(role),
    );
    if (unsupportedRole) {
      context.addIssue({
        code: "custom",
        path: ["inputs", index, "referenceRoles"],
        message: `ComfyUI image slot role ${unsupportedRole} is not accepted by the workflow identity contract`,
      });
    }
  }
  for (const acceptedRole of descriptor.identity.acceptedRoles) {
    if (!imageSlots.some((slot) => slot.referenceRoles?.includes(acceptedRole))) {
      context.addIssue({
        code: "custom",
        path: ["identity", "acceptedRoles"],
        message:
          `ComfyUI identity role ${acceptedRole} has no declared semantic image slot`,
      });
    }
  }
  if (!descriptor.identity.supportsSourceImageWithIdentity) return;
  const representativeIdentityRole =
    descriptor.identity.acceptedRoles.find((role) =>
      role === "identity_anchor" || role === "identity_reference"
    );
  const mixedAssignment = representativeIdentityRole
    ? assignWorkflowReferenceSlots(
        descriptor,
        [representativeIdentityRole, "source_image"],
      )
    : null;
  if (!mixedAssignment?.ok) {
    context.addIssue({
      code: "custom",
      path: ["inputs"],
      message:
        "source+identity workflows must assign representative source and identity references to distinct concrete slots",
    });
  }
});
export type WorkflowDescriptor = z.infer<typeof workflowDescriptorSchema>;

export type WorkflowReferenceContractView = {
  readonly backendKind: string;
  readonly identity: {
    readonly maxReferences: number;
    readonly acceptedRoles: readonly WorkflowReferenceRole[];
  };
  readonly inputs: readonly {
    readonly key: string;
    readonly type: string;
    readonly referenceRoles?: readonly WorkflowReferenceRole[];
    readonly required?: boolean;
  }[];
};

export type WorkflowReferenceSlotAssignment =
  | {
      readonly ok: true;
      readonly assignments: readonly {
        readonly slotKey: string;
        readonly referenceIndex: number;
      }[];
      readonly minReferences: number;
      readonly maxReferences: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "reference_cardinality_mismatch"
        | "reference_role_unsupported"
        | "reference_slot_assignment_impossible";
      readonly minReferences: number;
      readonly maxReferences: number;
    };

/**
 * SSoT for runtime reference cardinality and semantic slot assignment.
 *
 * ComfyUI graph inputs are concrete: every image slot must be filled and every
 * reference must map to one compatible slot. Command backends have no graph
 * slots, so their declared maxReferences remains an upper-bound capability
 * contract.
 */
export function assignWorkflowReferenceSlots(
  descriptor: WorkflowReferenceContractView,
  referenceRoles: readonly WorkflowReferenceRole[],
): WorkflowReferenceSlotAssignment {
  if (descriptor.backendKind !== "comfyui") {
    if (referenceRoles.length > descriptor.identity.maxReferences) {
      return {
        ok: false,
        reason: "reference_cardinality_mismatch",
        minReferences: 0,
        maxReferences: descriptor.identity.maxReferences,
      };
    }
    const unsupportedRole = referenceRoles.find(
      (role) => !descriptor.identity.acceptedRoles.includes(role),
    );
    if (unsupportedRole) {
      return {
        ok: false,
        reason: "reference_role_unsupported",
        minReferences: 0,
        maxReferences: descriptor.identity.maxReferences,
      };
    }
    return {
      ok: true,
      assignments: [],
      minReferences: 0,
      maxReferences: descriptor.identity.maxReferences,
    };
  }

  const imageSlots = descriptor.inputs.filter((slot) => slot.type === "image");
  const requiredSlotKeys = new Set(imageSlots.map((slot) => slot.key));
  const minReferences = requiredSlotKeys.size;
  const maxReferences = imageSlots.length;
  if (
    referenceRoles.length < minReferences ||
    referenceRoles.length > maxReferences
  ) {
    return {
      ok: false,
      reason: "reference_cardinality_mismatch",
      minReferences,
      maxReferences,
    };
  }
  const unsupportedRole = referenceRoles.find(
    (role) => !descriptor.identity.acceptedRoles.includes(role),
  );
  if (unsupportedRole) {
    return {
      ok: false,
      reason: "reference_role_unsupported",
      minReferences,
      maxReferences,
    };
  }

  const realItems = referenceRoles.map((role, referenceIndex) => ({
    kind: "reference" as const,
    referenceIndex,
    compatibleSlotIndexes: imageSlots.flatMap((slot, slotIndex) =>
      slot.referenceRoles?.includes(role) ? [slotIndex] : []
    ),
  }));
  if (realItems.some((item) => item.compatibleSlotIndexes.length === 0)) {
    return {
      ok: false,
      reason: "reference_slot_assignment_impossible",
      minReferences,
      maxReferences,
    };
  }
  const items = [...realItems].sort((left, right) =>
    left.compatibleSlotIndexes.length - right.compatibleSlotIndexes.length ||
    left.referenceIndex - right.referenceIndex
  );
  const itemIndexBySlot = Array<number>(imageSlots.length).fill(-1);
  const bindItem = (itemIndex: number, visitedSlotIndexes: Set<number>): boolean => {
    for (const slotIndex of items[itemIndex]!.compatibleSlotIndexes) {
      if (visitedSlotIndexes.has(slotIndex)) continue;
      visitedSlotIndexes.add(slotIndex);
      const occupyingItemIndex = itemIndexBySlot[slotIndex]!;
      if (
        occupyingItemIndex === -1 ||
        bindItem(occupyingItemIndex, visitedSlotIndexes)
      ) {
        itemIndexBySlot[slotIndex] = itemIndex;
        return true;
      }
    }
    return false;
  };
  if (items.some((_, itemIndex) => !bindItem(itemIndex, new Set()))) {
    return {
      ok: false,
      reason: "reference_slot_assignment_impossible",
      minReferences,
      maxReferences,
    };
  }

  return {
    ok: true,
    assignments: itemIndexBySlot.flatMap((itemIndex, slotIndex) => {
      const item = items[itemIndex];
      return item
        ? [{
            slotKey: imageSlots[slotIndex]!.key,
            referenceIndex: item.referenceIndex,
          }]
        : [];
    }),
    minReferences,
    maxReferences,
  };
}

function resolveValue(slot: WorkflowSlot, values: SlotValues) {
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
    const value = resolveValue(slot, values);
    for (const target of [slot.target, ...(slot.additionalTargets ?? [])]) {
      const node = prompt[target.nodeId];
      if (!node) {
        throw new Error(
          `workflow ${d.workflowKey}: slot ${slot.key} targets missing node ${target.nodeId}`,
        );
      }
      node.inputs[target.field] = value;
    }
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
