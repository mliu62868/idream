import {
  adminControlPlaneCommandAttemptStatusSchema,
  adminControlPlaneCommandStatusSchema,
  adminVerificationStateSchema,
  characterProjectPhaseSchema,
  characterReleaseStatusSchema,
  characterServingStateSchema,
  creativeLifecycleStateSchema,
  creativeRunItemStatusSchema,
  creativeWorkflowStageSchema,
  experimentStatusSchema,
  generationAttemptStatusSchema,
  generationJobStatusSchema,
  incidentStatusSchema,
  operationsCaseStatusSchema,
} from "@idream/shared/admin";

type StateOf<States extends readonly string[]> = States[number];
type TransitionRows<States extends readonly string[]> = {
  readonly [State in StateOf<States>]: readonly StateOf<States>[];
};

function defineTransitionAuthority<const States extends readonly string[]>(
  states: States,
  transitions: TransitionRows<States>,
) {
  const knownStates = new Set<string>(states);
  return {
    permits(from: string, to: string) {
      if (!knownStates.has(from) || !knownStates.has(to)) return false;
      return transitions[from as StateOf<States>].some((candidate) => candidate === to);
    },
  } as const;
}

export const CHARACTER_RELEASE_STATES = characterReleaseStatusSchema.options;

export const CHARACTER_PROJECT_PHASE_STATES = characterProjectPhaseSchema.options;

const CHARACTER_PROJECT_PHASE_AUTHORITY = defineTransitionAuthority(CHARACTER_PROJECT_PHASE_STATES, {
  idea: ["planned", "producing", "qa", "live_management", "retired"],
  planned: ["producing", "qa", "retired"],
  producing: ["qa", "retired"],
  qa: ["qa", "producing", "launch_ready", "retired"],
  launch_ready: ["producing", "live_management", "retired"],
  // INTENT: a live Character can submit an independently reviewed replacement
  // Release without taking the current Serving pointer offline.
  live_management: ["producing", "qa", "retired"],
  retired: [],
});

export function isCharacterProjectPhaseTransitionAllowed(from: string, to: string) {
  return CHARACTER_PROJECT_PHASE_AUTHORITY.permits(from, to);
}

// SPEC: Release 的合法创建入口状态 —— 创建也要过状态机的门。
// INTENT: Release 不是「建出来再一步步推进」的：propose 一次性钉死不可变快照后直接进评审，
// rollback 复制一份已验证过的历史快照直接进 approved，编辑态导入直接进 published。状态机此前
// 只管更新、创建绕过它，也没有任何地方写明这一点。`satisfies CharacterReleaseCreationState`
// 让创建点选错入口状态变成编译错误。
export const CHARACTER_RELEASE_CREATION_STATES = [
  "in_review",
  "approved",
  "published",
] as const;

export type CharacterReleaseCreationState =
  (typeof CHARACTER_RELEASE_CREATION_STATES)[number];

// INVARIANT: draft / validating 没有任何写入者 —— 上面三个入口状态覆盖了全部创建路径，也没有
// 转移能到达它们。两个取值保留在 `characterReleaseStatusSchema`（跨包 wire 契约）与 Prisma 列
// 默认值里，所以这里不删取值，只让它们没有出边：万一有人绕过入口状态建出一行 draft，它会卡死，
// 而不是悄悄走完发布链。
const CHARACTER_RELEASE_AUTHORITY = defineTransitionAuthority(CHARACTER_RELEASE_STATES, {
  draft: [],
  validating: [],
  in_review: ["withdrawn", "approved"],
  approved: ["published"],
  published: ["superseded", "withdrawn"],
  superseded: [],
  withdrawn: [],
});

export function isCharacterReleaseTransitionAllowed(from: string, to: string) {
  return CHARACTER_RELEASE_AUTHORITY.permits(from, to);
}

export const CHARACTER_SERVING_STATES = characterServingStateSchema.options;

const CHARACTER_SERVING_AUTHORITY = defineTransitionAuthority(CHARACTER_SERVING_STATES, {
  inactive: ["live", "retired"],
  live: ["live", "paused", "retired"],
  paused: ["live", "retired"],
  retired: [],
});

export function isCharacterServingTransitionAllowed(from: string, to: string) {
  return CHARACTER_SERVING_AUTHORITY.permits(from, to);
}

export const GENERATION_REQUEST_STATES = generationJobStatusSchema.options;

const GENERATION_REQUEST_AUTHORITY = defineTransitionAuthority(GENERATION_REQUEST_STATES, {
  queued: ["moderating_input", "running", "moderating_output", "failed", "blocked", "cancelled"],
  moderating_input: ["moderating_input", "running", "moderating_output", "failed", "blocked", "cancelled"],
  running: ["running", "moderating_output", "completed", "failed", "blocked", "cancelled"],
  moderating_output: ["moderating_output", "completed", "failed", "blocked", "cancelled"],
  completed: ["completed"],
  failed: ["queued", "failed"],
  blocked: ["blocked"],
  refunded: ["refunded"],
  cancelled: ["cancelled"],
});

export function isGenerationRequestTransitionAllowed(from: string, to: string) {
  return GENERATION_REQUEST_AUTHORITY.permits(from, to);
}

export const GENERATION_ATTEMPT_STATES = generationAttemptStatusSchema.options;

const GENERATION_ATTEMPT_AUTHORITY = defineTransitionAuthority(GENERATION_ATTEMPT_STATES, {
  queued: ["queued", "running", "succeeded", "failed", "blocked", "cancelled", "unknown"],
  running: ["running", "succeeded", "failed", "blocked", "cancelled", "unknown"],
  succeeded: ["succeeded"],
  failed: ["failed"],
  blocked: ["blocked"],
  cancelled: ["cancelled"],
  unknown: ["unknown"],
});

export function isGenerationAttemptTransitionAllowed(from: string, to: string) {
  return GENERATION_ATTEMPT_AUTHORITY.permits(from, to);
}

export const CREATIVE_RUN_LIFECYCLE_STATES = creativeLifecycleStateSchema.options;

const CREATIVE_RUN_LIFECYCLE_AUTHORITY = defineTransitionAuthority(CREATIVE_RUN_LIFECYCLE_STATES, {
  draft: ["active"],
  active: ["active", "closed"],
  closed: ["active", "closed"],
  archived: [],
});

export function isCreativeRunLifecycleTransitionAllowed(from: string, to: string) {
  return CREATIVE_RUN_LIFECYCLE_AUTHORITY.permits(from, to);
}

export const CREATIVE_RUN_WORKFLOW_STAGES = creativeWorkflowStageSchema.options;

const CREATIVE_RUN_WORKFLOW_AUTHORITY = defineTransitionAuthority(CREATIVE_RUN_WORKFLOW_STAGES, {
  brief: ["directions"],
  directions: ["generation"],
  generation: ["generation", "review", "placement", "verification"],
  review: ["generation", "review", "placement", "verification"],
  placement: ["generation", "review", "placement", "verification"],
  verification: ["generation", "review", "placement", "verification"],
});

export function isCreativeRunWorkflowTransitionAllowed(from: string, to: string) {
  return CREATIVE_RUN_WORKFLOW_AUTHORITY.permits(from, to);
}

export const CREATIVE_RUN_VERIFICATION_STATES = adminVerificationStateSchema.options;

const CREATIVE_RUN_VERIFICATION_AUTHORITY = defineTransitionAuthority(CREATIVE_RUN_VERIFICATION_STATES, {
  pending: ["pending", "verifying", "passed"],
  verifying: ["pending", "passed", "failed"],
  passed: ["verifying"],
  failed: ["verifying"],
  overridden: ["verifying"],
});

export function isCreativeRunVerificationTransitionAllowed(from: string, to: string) {
  return CREATIVE_RUN_VERIFICATION_AUTHORITY.permits(from, to);
}

export const CREATIVE_PLACEMENT_VERIFICATION_STATES = adminVerificationStateSchema.options;

const CREATIVE_PLACEMENT_VERIFICATION_AUTHORITY = defineTransitionAuthority(CREATIVE_PLACEMENT_VERIFICATION_STATES, {
  pending: ["verifying"],
  verifying: ["passed", "failed", "overridden"],
  passed: [],
  failed: ["verifying"],
  overridden: [],
});

export function isCreativePlacementVerificationTransitionAllowed(from: string, to: string) {
  return CREATIVE_PLACEMENT_VERIFICATION_AUTHORITY.permits(from, to);
}

export const CREATIVE_RUN_ITEM_STATES = creativeRunItemStatusSchema.options;

const CREATIVE_RUN_ITEM_AUTHORITY = defineTransitionAuthority(CREATIVE_RUN_ITEM_STATES, {
  queued: ["generated", "failed"],
  generated: ["approved", "rejected"],
  approved: ["approved", "rejected", "published"],
  rejected: ["approved", "rejected"],
  regenerate_requested: ["generated", "failed"],
  published: ["published"],
  failed: ["regenerate_requested"],
});

export function isCreativeRunItemTransitionAllowed(from: string, to: string) {
  return CREATIVE_RUN_ITEM_AUTHORITY.permits(from, to);
}

export const INCIDENT_STATES = incidentStatusSchema.options;

const INCIDENT_AUTHORITY = defineTransitionAuthority(INCIDENT_STATES, {
  detected: ["triaged", "mitigating"],
  triaged: ["triaged", "mitigating", "merged"],
  mitigating: ["mitigating", "monitoring"],
  monitoring: ["mitigating", "monitoring", "resolved"],
  resolved: ["closed"],
  closed: [],
  duplicate: [],
  merged: [],
});

export function isIncidentTransitionAllowed(from: string, to: string) {
  return INCIDENT_AUTHORITY.permits(from, to);
}

export const ADMIN_CASE_STATES = operationsCaseStatusSchema.options;

const ADMIN_CASE_AUTHORITY = defineTransitionAuthority(ADMIN_CASE_STATES, {
  new: ["triaged", "in_progress", "waiting", "resolved"],
  triaged: ["triaged", "in_progress", "waiting", "resolved"],
  in_progress: ["in_progress", "waiting", "resolved"],
  waiting: ["waiting", "in_progress", "resolved"],
  resolved: ["in_progress", "closed", "reopened"],
  closed: ["reopened"],
  reopened: ["triaged", "in_progress", "waiting", "resolved"],
});

export function isAdminCaseTransitionAllowed(from: string, to: string) {
  return ADMIN_CASE_AUTHORITY.permits(from, to);
}

export const EXPERIMENT_STATES = experimentStatusSchema.options;

const EXPERIMENT_AUTHORITY = defineTransitionAuthority(EXPERIMENT_STATES, {
  draft: ["running"],
  running: ["stopped"],
  stopped: [],
});

export function isExperimentTransitionAllowed(from: string, to: string) {
  return EXPERIMENT_AUTHORITY.permits(from, to);
}

export const CONTROL_PLANE_COMMAND_STATES = adminControlPlaneCommandStatusSchema.options;

const CONTROL_PLANE_COMMAND_AUTHORITY = defineTransitionAuthority(CONTROL_PLANE_COMMAND_STATES, {
  accepted: ["running"],
  running: ["accepted", "verifying", "succeeded", "failed"],
  verifying: ["accepted", "succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
});

export function isControlPlaneCommandTransitionAllowed(from: string, to: string) {
  return CONTROL_PLANE_COMMAND_AUTHORITY.permits(from, to);
}

export const CONTROL_PLANE_COMMAND_ATTEMPT_STATES = adminControlPlaneCommandAttemptStatusSchema.options;

const CONTROL_PLANE_COMMAND_ATTEMPT_AUTHORITY = defineTransitionAuthority(CONTROL_PLANE_COMMAND_ATTEMPT_STATES, {
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
});

export function isControlPlaneCommandAttemptTransitionAllowed(from: string, to: string) {
  return CONTROL_PLANE_COMMAND_ATTEMPT_AUTHORITY.permits(from, to);
}
