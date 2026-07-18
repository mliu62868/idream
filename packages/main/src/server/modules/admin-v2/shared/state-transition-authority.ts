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
  qa: ["producing", "launch_ready", "retired"],
  launch_ready: ["producing", "live_management", "retired"],
  live_management: ["producing", "retired"],
  retired: [],
});

export function isCharacterProjectPhaseTransitionAllowed(from: string, to: string) {
  return CHARACTER_PROJECT_PHASE_AUTHORITY.permits(from, to);
}

const CHARACTER_RELEASE_AUTHORITY = defineTransitionAuthority(CHARACTER_RELEASE_STATES, {
  draft: ["validating"],
  validating: ["in_review"],
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
  inactive: ["live"],
  live: ["live", "paused", "retired"],
  paused: ["live"],
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
  queued: ["queued", "running", "succeeded", "failed", "cancelled", "unknown"],
  running: ["running", "succeeded", "failed", "cancelled", "unknown"],
  succeeded: ["succeeded"],
  failed: ["failed"],
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
