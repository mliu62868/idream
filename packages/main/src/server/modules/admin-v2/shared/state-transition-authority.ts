import {
  characterReleaseStatusSchema,
  characterServingStateSchema,
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

const CHARACTER_RELEASE_AUTHORITY = defineTransitionAuthority(CHARACTER_RELEASE_STATES, {
  draft: ["validating"],
  validating: ["in_review"],
  in_review: ["draft", "approved"],
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

export const GENERATION_REQUEST_ADMIN_STATES = [
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
  "completed",
  "failed",
  "blocked",
  "refunded",
  "cancelled",
] as const;

const GENERATION_REQUEST_ADMIN_AUTHORITY = defineTransitionAuthority(GENERATION_REQUEST_ADMIN_STATES, {
  queued: ["cancelled"],
  moderating_input: ["cancelled"],
  running: ["cancelled"],
  moderating_output: ["cancelled"],
  completed: [],
  failed: ["queued"],
  blocked: [],
  refunded: [],
  cancelled: [],
});

export function isGenerationRequestAdminTransitionAllowed(from: string, to: string) {
  return GENERATION_REQUEST_ADMIN_AUTHORITY.permits(from, to);
}

export const GENERATION_ATTEMPT_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;

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

export const CREATIVE_RUN_LIFECYCLE_STATES = ["draft", "active", "closed", "archived"] as const;

const CREATIVE_RUN_LIFECYCLE_AUTHORITY = defineTransitionAuthority(CREATIVE_RUN_LIFECYCLE_STATES, {
  draft: ["active"],
  active: ["active", "closed"],
  closed: ["active", "closed"],
  archived: [],
});

export function isCreativeRunLifecycleTransitionAllowed(from: string, to: string) {
  return CREATIVE_RUN_LIFECYCLE_AUTHORITY.permits(from, to);
}

export const CREATIVE_RUN_ITEM_STATES = [
  "queued",
  "generated",
  "approved",
  "rejected",
  "regenerate_requested",
  "published",
  "failed",
] as const;

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

export const INCIDENT_STATES = [
  "detected",
  "triaged",
  "mitigating",
  "monitoring",
  "resolved",
  "closed",
  "duplicate",
  "merged",
] as const;

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

export const ADMIN_CASE_STATES = [
  "new",
  "triaged",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
  "reopened",
] as const;

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

export const EXPERIMENT_STATES = ["draft", "running", "stopped"] as const;

const EXPERIMENT_AUTHORITY = defineTransitionAuthority(EXPERIMENT_STATES, {
  draft: ["running"],
  running: ["stopped"],
  stopped: [],
});

export function isExperimentTransitionAllowed(from: string, to: string) {
  return EXPERIMENT_AUTHORITY.permits(from, to);
}

export const CONTROL_PLANE_COMMAND_STATES = [
  "accepted",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
] as const;

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
