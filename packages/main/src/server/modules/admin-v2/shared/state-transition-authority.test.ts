import { describe, expect, it } from "vitest";
import {
  ADMIN_CASE_STATES,
  CHARACTER_PROJECT_PHASE_STATES,
  CHARACTER_RELEASE_STATES,
  CHARACTER_SERVING_STATES,
  CONTROL_PLANE_COMMAND_STATES,
  CONTROL_PLANE_COMMAND_ATTEMPT_STATES,
  CREATIVE_PLACEMENT_VERIFICATION_STATES,
  CREATIVE_RUN_ITEM_STATES,
  CREATIVE_RUN_LIFECYCLE_STATES,
  CREATIVE_RUN_VERIFICATION_STATES,
  CREATIVE_RUN_WORKFLOW_STAGES,
  EXPERIMENT_STATES,
  GENERATION_ATTEMPT_STATES,
  GENERATION_REQUEST_STATES,
  INCIDENT_STATES,
  isAdminCaseTransitionAllowed,
  isCharacterProjectPhaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
  isCharacterServingTransitionAllowed,
  isControlPlaneCommandTransitionAllowed,
  isControlPlaneCommandAttemptTransitionAllowed,
  isCreativePlacementVerificationTransitionAllowed,
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
  isCreativeRunVerificationTransitionAllowed,
  isCreativeRunWorkflowTransitionAllowed,
  isExperimentTransitionAllowed,
  isGenerationAttemptTransitionAllowed,
  isGenerationRequestTransitionAllowed,
  isIncidentTransitionAllowed,
} from "./state-transition-authority";

interface MatrixCase {
  readonly name: string;
  readonly states: readonly string[];
  readonly allowed: Readonly<Record<string, readonly string[]>>;
  readonly permits: (from: string, to: string) => boolean;
}

const matrices: readonly MatrixCase[] = [
  {
    name: "Character Project phase",
    states: CHARACTER_PROJECT_PHASE_STATES,
    allowed: {
      idea: ["planned", "producing", "qa", "live_management", "retired"],
      planned: ["producing", "qa", "retired"],
      producing: ["qa", "retired"],
      qa: ["qa", "producing", "launch_ready", "retired"],
      launch_ready: ["producing", "live_management", "retired"],
      live_management: ["producing", "retired"],
      retired: [],
    },
    permits: isCharacterProjectPhaseTransitionAllowed,
  },
  {
    name: "Character Release",
    states: CHARACTER_RELEASE_STATES,
    allowed: {
      draft: ["validating"],
      validating: ["in_review"],
      in_review: ["withdrawn", "approved"],
      approved: ["published"],
      published: ["superseded", "withdrawn"],
      superseded: [],
      withdrawn: [],
    },
    permits: isCharacterReleaseTransitionAllowed,
  },
  {
    name: "Character Serving",
    states: CHARACTER_SERVING_STATES,
    allowed: {
      inactive: ["live", "retired"],
      live: ["live", "paused", "retired"],
      paused: ["live", "retired"],
      retired: [],
    },
    permits: isCharacterServingTransitionAllowed,
  },
  {
    name: "Generation Request",
    states: GENERATION_REQUEST_STATES,
    allowed: {
      queued: ["moderating_input", "running", "moderating_output", "failed", "blocked", "cancelled"],
      moderating_input: ["moderating_input", "running", "moderating_output", "failed", "blocked", "cancelled"],
      running: ["running", "moderating_output", "completed", "failed", "blocked", "cancelled"],
      moderating_output: ["moderating_output", "completed", "failed", "blocked", "cancelled"],
      completed: ["completed"],
      failed: ["queued", "failed"],
      blocked: ["blocked"],
      refunded: ["refunded"],
      cancelled: ["cancelled"],
    },
    permits: isGenerationRequestTransitionAllowed,
  },
  {
    name: "Generation Attempt",
    states: GENERATION_ATTEMPT_STATES,
    allowed: {
      queued: ["queued", "running", "succeeded", "failed", "cancelled", "unknown"],
      running: ["running", "succeeded", "failed", "cancelled", "unknown"],
      succeeded: ["succeeded"],
      failed: ["failed"],
      cancelled: ["cancelled"],
      unknown: ["unknown"],
    },
    permits: isGenerationAttemptTransitionAllowed,
  },
  {
    name: "Creative Run lifecycle",
    states: CREATIVE_RUN_LIFECYCLE_STATES,
    allowed: {
      draft: ["active"],
      active: ["active", "closed"],
      closed: ["active", "closed"],
      archived: [],
    },
    permits: isCreativeRunLifecycleTransitionAllowed,
  },
  {
    name: "Creative Run workflow",
    states: CREATIVE_RUN_WORKFLOW_STAGES,
    allowed: {
      brief: ["directions"],
      directions: ["generation"],
      generation: ["generation", "review", "placement", "verification"],
      review: ["generation", "review", "placement", "verification"],
      placement: ["generation", "review", "placement", "verification"],
      verification: ["generation", "review", "placement", "verification"],
    },
    permits: isCreativeRunWorkflowTransitionAllowed,
  },
  {
    name: "Creative Run verification",
    states: CREATIVE_RUN_VERIFICATION_STATES,
    allowed: {
      pending: ["pending", "verifying", "passed"],
      verifying: ["pending", "passed", "failed"],
      passed: ["verifying"],
      failed: ["verifying"],
      overridden: ["verifying"],
    },
    permits: isCreativeRunVerificationTransitionAllowed,
  },
  {
    name: "Creative placement verification",
    states: CREATIVE_PLACEMENT_VERIFICATION_STATES,
    allowed: {
      pending: ["verifying"],
      verifying: ["passed", "failed", "overridden"],
      passed: [],
      failed: ["verifying"],
      overridden: [],
    },
    permits: isCreativePlacementVerificationTransitionAllowed,
  },
  {
    name: "Creative Run Item",
    states: CREATIVE_RUN_ITEM_STATES,
    allowed: {
      queued: ["generated", "failed"],
      generated: ["approved", "rejected"],
      approved: ["approved", "rejected", "published"],
      rejected: ["approved", "rejected"],
      regenerate_requested: ["generated", "failed"],
      published: ["published"],
      failed: ["regenerate_requested"],
    },
    permits: isCreativeRunItemTransitionAllowed,
  },
  {
    name: "Incident",
    states: INCIDENT_STATES,
    allowed: {
      detected: ["triaged", "mitigating"],
      triaged: ["triaged", "mitigating", "merged"],
      mitigating: ["mitigating", "monitoring"],
      monitoring: ["mitigating", "monitoring", "resolved"],
      resolved: ["closed"],
      closed: [],
      duplicate: [],
      merged: [],
    },
    permits: isIncidentTransitionAllowed,
  },
  {
    name: "Case",
    states: ADMIN_CASE_STATES,
    allowed: {
      new: ["triaged", "in_progress", "waiting", "resolved"],
      triaged: ["triaged", "in_progress", "waiting", "resolved"],
      in_progress: ["in_progress", "waiting", "resolved"],
      waiting: ["waiting", "in_progress", "resolved"],
      resolved: ["in_progress", "closed", "reopened"],
      closed: ["reopened"],
      reopened: ["triaged", "in_progress", "waiting", "resolved"],
    },
    permits: isAdminCaseTransitionAllowed,
  },
  {
    name: "Experiment",
    states: EXPERIMENT_STATES,
    allowed: {
      draft: ["running"],
      running: ["stopped"],
      stopped: [],
    },
    permits: isExperimentTransitionAllowed,
  },
  {
    name: "ControlPlaneCommand",
    states: CONTROL_PLANE_COMMAND_STATES,
    allowed: {
      accepted: ["running"],
      running: ["accepted", "verifying", "succeeded", "failed"],
      verifying: ["accepted", "succeeded", "failed"],
      succeeded: [],
      failed: [],
      cancelled: [],
    },
    permits: isControlPlaneCommandTransitionAllowed,
  },
  {
    name: "ControlPlaneCommandAttempt",
    states: CONTROL_PLANE_COMMAND_ATTEMPT_STATES,
    allowed: {
      running: ["succeeded", "failed"],
      succeeded: [],
      failed: [],
    },
    permits: isControlPlaneCommandAttemptTransitionAllowed,
  },
];

describe.each(matrices)("$name transition authority", ({ states, allowed, permits }) => {
  it("defines every finite state exactly once", () => {
    expect(new Set(states).size).toBe(states.length);
    expect(Object.keys(allowed).sort()).toEqual([...states].sort());
  });

  it("allows and denies the complete from-state by to-state matrix", () => {
    for (const from of states) {
      for (const to of states) {
        expect(permits(from, to), `${from} -> ${to}`).toBe(allowed[from].includes(to));
      }
    }
  });

  it("fails closed for states outside the finite authority", () => {
    expect(permits("__unknown_from__", states[0])).toBe(false);
    expect(permits(states[0], "__unknown_to__")).toBe(false);
  });
});
