import { jsonRecord } from "./json";

// SPEC: Creative Run / Run item 的纯状态推导 —— 不读库、不写库、不涉及事务。
// INTENT: 这几条判断同时被评审、投放和读投影三条路径用到。留在原来那个大文件里时，
// 「这一轮还能不能往下走」「这个候选算不算失败」看起来像是评审路径的私事，实际上投放
// 验证成功之后也要用同一条规则续推 Run 状态 —— 两边各写一份就会出现「评审说已收尾、
// 投放说还在进行」。

export function creativeIdentityReviewMode(input: {
  readonly purpose: string;
  readonly sourceMeta: unknown;
}) {
  if (input.purpose === "model_eval") {
    return "preserves_identity" as const;
  }
  if (input.purpose === "identity_calibration") {
    return "defines_identity" as const;
  }
  if (![
    "character_cover",
    "character_hero",
    "character_chat",
    "character_video",
  ].includes(input.purpose)) {
    return "not_applicable" as const;
  }
  return jsonRecord(input.sourceMeta).bootstrapIdentity === true
    ? "defines_identity" as const
    : "preserves_identity" as const;
}

export function approvedIdentityConsistencyForMode(
  mode: ReturnType<typeof creativeIdentityReviewMode>,
) {
  if (mode === "defines_identity") return "unscored" as const;
  if (mode === "preserves_identity") return "passed" as const;
  return null;
}

export function deriveCreativeItemExecutionState(input: {
  readonly itemStatus: string;
  readonly jobStatus: string | null;
  readonly attemptStatus: string | null;
  readonly transportStatus: string | null;
  readonly hasAsset: boolean;
}) {
  if (input.hasAsset) return "ready" as const;
  if (
    input.itemStatus === "failed" ||
    ["failed", "blocked", "refunded"].includes(input.jobStatus ?? "") ||
    ["failed", "cancelled", "unknown"].includes(input.attemptStatus ?? "") ||
    ["failed", "unknown"].includes(input.transportStatus ?? "")
  ) {
    return "failed" as const;
  }
  if (
    input.transportStatus === "succeeded" ||
    input.attemptStatus === "succeeded" ||
    input.jobStatus === "completed"
  ) {
    return "finalizing" as const;
  }
  if (
    input.transportStatus === "running" ||
    input.attemptStatus === "running" ||
    ["running", "moderating_input", "moderating_output"].includes(input.jobStatus ?? "")
  ) {
    return "generating" as const;
  }
  if (input.attemptStatus === "queued" || input.jobStatus === "queued") {
    return "provider_queued" as const;
  }
  return "dispatching" as const;
}

export function deriveCreativeRunContinuation(
  itemStatuses: readonly string[],
  options: { readonly requiresVerifiedPlacement?: boolean } = {},
) {
  const requiresVerifiedPlacement = options.requiresVerifiedPlacement ?? true;
  const terminalStatuses = requiresVerifiedPlacement
    ? ["published", "rejected", "failed"]
    : ["approved", "published", "rejected", "failed"];
  const allResolved = itemStatuses.length > 0 &&
    itemStatuses.every((status) => terminalStatuses.includes(status));
  if (allResolved) {
    const runtimeVerified = requiresVerifiedPlacement &&
      itemStatuses.some((status) => status === "published");
    return {
      lifecycleState: "closed" as const,
      workflowStage: runtimeVerified ? "verification" as const : "review" as const,
      verificationState: runtimeVerified ? "passed" as const : "pending" as const,
      status: "completed" as const,
    };
  }
  const workflowStage = itemStatuses.some((status) => ["queued", "regenerate_requested"].includes(status))
    ? "generation" as const
    : itemStatuses.some((status) => status === "generated")
      ? "review" as const
      : "placement" as const;
  return {
    lifecycleState: "active" as const,
    workflowStage,
    verificationState: "pending" as const,
    status: "reviewing" as const,
  };
}
