import { describe, expect, it } from "vitest";
import {
  ADMIN_CASE_STATES,
  CHARACTER_RELEASE_STATES,
  CHARACTER_SERVING_STATES,
  CONTROL_PLANE_COMMAND_STATES,
  CREATIVE_RUN_ITEM_STATES,
  CREATIVE_RUN_LIFECYCLE_STATES,
  EXPERIMENT_STATES,
  GENERATION_ATTEMPT_STATES,
  GENERATION_REQUEST_ADMIN_STATES,
  INCIDENT_STATES,
  isAdminCaseTransitionAllowed,
  isCharacterReleaseTransitionAllowed,
  isCharacterServingTransitionAllowed,
  isControlPlaneCommandTransitionAllowed,
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
  isExperimentTransitionAllowed,
  isGenerationAttemptTransitionAllowed,
  isGenerationRequestAdminTransitionAllowed,
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
    name: "Character Release",
    states: CHARACTER_RELEASE_STATES,
    allowed: {
      draft: [],
      in_review: ["draft", "approved"],
      approved: ["published"],
      published: ["superseded"],
      superseded: [],
    },
    permits: isCharacterReleaseTransitionAllowed,
  },
  {
    name: "Character Serving",
    states: CHARACTER_SERVING_STATES,
    allowed: {
      inactive: ["live"],
      live: ["live", "paused", "retired"],
      paused: ["live"],
      retired: [],
    },
    permits: isCharacterServingTransitionAllowed,
  },
  {
    name: "Generation Request admin actions",
    states: GENERATION_REQUEST_ADMIN_STATES,
    allowed: {
      queued: ["cancelled"],
      moderating_input: ["cancelled"],
      running: ["cancelled"],
      moderating_output: ["cancelled"],
      completed: [],
      failed: ["queued"],
      blocked: [],
      refunded: [],
      cancelled: [],
    },
    permits: isGenerationRequestAdminTransitionAllowed,
  },
  {
    name: "Generation Attempt",
    states: GENERATION_ATTEMPT_STATES,
    allowed: {
      queued: ["queued", "running", "succeeded", "failed", "cancelled", "unknown"],
      running: ["running", "succeeded", "failed", "cancelled", "unknown"],
      succeeded: [],
      failed: [],
      cancelled: [],
      unknown: [],
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
      resolved: ["closed", "reopened"],
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
