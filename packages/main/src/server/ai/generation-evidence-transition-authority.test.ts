import { describe, expect, it } from "vitest";
import {
  GENERATION_ARTIFACT_ARCHIVE_STATES,
  GENERATION_ARTIFACT_VALIDATION_STATES,
  GENERATION_DELIVERY_STATES,
  GENERATION_TRANSPORT_EXECUTION_STATES,
  isGenerationArtifactArchiveTransitionAllowed,
  isGenerationArtifactValidationTransitionAllowed,
  isGenerationDeliveryTransitionAllowed,
  isGenerationTransportExecutionTransitionAllowed,
} from "./generation-evidence-transition-authority";

const matrices = [
  {
    name: "TransportExecution",
    states: GENERATION_TRANSPORT_EXECUTION_STATES,
    allowed: {
      running: ["running", "succeeded", "failed", "unknown"],
      succeeded: ["succeeded"],
      failed: ["failed"],
      unknown: ["unknown"],
    },
    permits: isGenerationTransportExecutionTransitionAllowed,
  },
  {
    name: "Artifact validation",
    states: GENERATION_ARTIFACT_VALIDATION_STATES,
    allowed: {
      produced: ["produced", "valid", "invalid", "rejected", "late_after_failed", "late_after_blocked", "late_after_cancel", "late_after_cancelled", "late_after_refunded", "late_after_unknown"],
      valid: ["valid", "late_after_failed", "late_after_blocked", "late_after_cancel", "late_after_cancelled", "late_after_refunded", "late_after_unknown"],
      invalid: ["invalid"],
      rejected: ["rejected"],
      late_after_failed: ["late_after_failed"],
      late_after_blocked: ["late_after_blocked"],
      late_after_cancel: ["late_after_cancel"],
      late_after_cancelled: ["late_after_cancelled"],
      late_after_refunded: ["late_after_refunded"],
      late_after_unknown: ["late_after_unknown"],
    },
    permits: isGenerationArtifactValidationTransitionAllowed,
  },
  {
    name: "Artifact archive",
    states: GENERATION_ARTIFACT_ARCHIVE_STATES,
    allowed: { active: ["active", "archived"], archived: ["archived"] },
    permits: isGenerationArtifactArchiveTransitionAllowed,
  },
  {
    name: "Delivery",
    states: GENERATION_DELIVERY_STATES,
    allowed: {
      pending: ["pending", "delivered", "failed", "suppressed"],
      delivered: ["delivered"],
      failed: ["failed"],
      suppressed: ["suppressed"],
    },
    permits: isGenerationDeliveryTransitionAllowed,
  },
] as const;

describe.each(matrices)("$name finite authority", ({ states, allowed, permits }) => {
  it("allows and denies the complete matrix", () => {
    const expected = allowed as Readonly<Record<string, readonly string[]>>;
    expect(Object.keys(allowed).sort()).toEqual([...states].sort());
    for (const from of states) {
      for (const to of states) {
        expect(permits(from, to), `${from} -> ${to}`).toBe(expected[from].includes(to));
      }
    }
  });

  it("fails closed outside the shared state set", () => {
    expect(permits("__unknown__", states[0])).toBe(false);
    expect(permits(states[0], "__unknown__")).toBe(false);
  });
});
