type TransitionMap = Readonly<Record<string, readonly string[]>>;

function permitsTransition(
  authority: TransitionMap,
  from: string,
  to: string,
) {
  return Object.hasOwn(authority, from) && authority[from].includes(to);
}

export const CHARACTER_RELEASE_STATES = [
  "draft",
  "in_review",
  "approved",
  "published",
  "superseded",
] as const;

const CHARACTER_RELEASE_TRANSITIONS = {
  draft: [],
  in_review: ["draft", "approved"],
  approved: ["published"],
  published: ["superseded"],
  superseded: [],
} as const satisfies TransitionMap;

export function isCharacterReleaseTransitionAllowed(from: string, to: string) {
  return permitsTransition(CHARACTER_RELEASE_TRANSITIONS, from, to);
}

export const CHARACTER_SERVING_STATES = ["inactive", "live", "paused", "retired"] as const;

const CHARACTER_SERVING_TRANSITIONS = {
  inactive: ["live"],
  live: ["live", "paused", "retired"],
  paused: ["live"],
  retired: [],
} as const satisfies TransitionMap;

export function isCharacterServingTransitionAllowed(from: string, to: string) {
  return permitsTransition(CHARACTER_SERVING_TRANSITIONS, from, to);
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

const GENERATION_REQUEST_ADMIN_TRANSITIONS = {
  queued: ["cancelled"],
  moderating_input: ["cancelled"],
  running: ["cancelled"],
  moderating_output: ["cancelled"],
  completed: [],
  failed: ["queued"],
  blocked: [],
  refunded: [],
  cancelled: [],
} as const satisfies TransitionMap;

export function isGenerationRequestAdminTransitionAllowed(from: string, to: string) {
  return permitsTransition(GENERATION_REQUEST_ADMIN_TRANSITIONS, from, to);
}

export const GENERATION_ATTEMPT_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;

const GENERATION_ATTEMPT_TRANSITIONS = {
  queued: ["queued", "running", "succeeded", "failed", "cancelled", "unknown"],
  running: ["running", "succeeded", "failed", "cancelled", "unknown"],
  succeeded: [],
  failed: [],
  cancelled: [],
  unknown: [],
} as const satisfies TransitionMap;

export function isGenerationAttemptTransitionAllowed(from: string, to: string) {
  return permitsTransition(GENERATION_ATTEMPT_TRANSITIONS, from, to);
}

export const CREATIVE_RUN_LIFECYCLE_STATES = ["draft", "active", "closed", "archived"] as const;

const CREATIVE_RUN_LIFECYCLE_TRANSITIONS = {
  draft: ["active"],
  active: ["active", "closed"],
  closed: ["active", "closed"],
  archived: [],
} as const satisfies TransitionMap;

export function isCreativeRunLifecycleTransitionAllowed(from: string, to: string) {
  return permitsTransition(CREATIVE_RUN_LIFECYCLE_TRANSITIONS, from, to);
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

const CREATIVE_RUN_ITEM_TRANSITIONS = {
  queued: ["generated", "failed"],
  generated: ["approved", "rejected"],
  approved: ["approved", "rejected", "published"],
  rejected: ["approved", "rejected"],
  regenerate_requested: ["generated", "failed"],
  published: ["published"],
  failed: ["regenerate_requested"],
} as const satisfies TransitionMap;

export function isCreativeRunItemTransitionAllowed(from: string, to: string) {
  return permitsTransition(CREATIVE_RUN_ITEM_TRANSITIONS, from, to);
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

const INCIDENT_TRANSITIONS = {
  detected: ["triaged", "mitigating"],
  triaged: ["triaged", "mitigating", "merged"],
  mitigating: ["mitigating", "monitoring"],
  monitoring: ["mitigating", "monitoring", "resolved"],
  resolved: ["closed"],
  closed: [],
  duplicate: [],
  merged: [],
} as const satisfies TransitionMap;

export function isIncidentTransitionAllowed(from: string, to: string) {
  return permitsTransition(INCIDENT_TRANSITIONS, from, to);
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

const ADMIN_CASE_TRANSITIONS = {
  new: ["triaged", "in_progress", "waiting", "resolved"],
  triaged: ["triaged", "in_progress", "waiting", "resolved"],
  in_progress: ["in_progress", "waiting", "resolved"],
  waiting: ["waiting", "in_progress", "resolved"],
  resolved: ["closed", "reopened"],
  closed: ["reopened"],
  reopened: ["triaged", "in_progress", "waiting", "resolved"],
} as const satisfies TransitionMap;

export function isAdminCaseTransitionAllowed(from: string, to: string) {
  return permitsTransition(ADMIN_CASE_TRANSITIONS, from, to);
}

export const EXPERIMENT_STATES = ["draft", "running", "stopped"] as const;

const EXPERIMENT_TRANSITIONS = {
  draft: ["running"],
  running: ["stopped"],
  stopped: [],
} as const satisfies TransitionMap;

export function isExperimentTransitionAllowed(from: string, to: string) {
  return permitsTransition(EXPERIMENT_TRANSITIONS, from, to);
}

export const CONTROL_PLANE_COMMAND_STATES = [
  "accepted",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
] as const;

const CONTROL_PLANE_COMMAND_TRANSITIONS = {
  accepted: ["running"],
  running: ["accepted", "verifying", "succeeded", "failed"],
  verifying: ["accepted", "succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
} as const satisfies TransitionMap;

export function isControlPlaneCommandTransitionAllowed(from: string, to: string) {
  return permitsTransition(CONTROL_PLANE_COMMAND_TRANSITIONS, from, to);
}
