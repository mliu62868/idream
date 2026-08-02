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
  lateArtifactDisposition,
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
      produced: ["produced", "valid", "invalid", "rejected", "late_after_failed", "late_after_blocked", "late_after_cancelled", "late_after_refunded", "late_after_unknown"],
      valid: ["valid", "late_after_failed", "late_after_blocked", "late_after_cancelled", "late_after_refunded", "late_after_unknown"],
      invalid: ["invalid"],
      rejected: ["rejected"],
      late_after_failed: ["late_after_failed"],
      late_after_blocked: ["late_after_blocked"],
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

describe("late artifact disposition", () => {
  // INTENT: terminal-record ingest reads the Attempt status and finalize reads
  // the Request status. Both describe the same fact — the artifact showed up too
  // late — so both must land on the same state or operator counts split in half.
  it("names a cancelled arrival identically from either side", () => {
    expect(lateArtifactDisposition({ attemptStatus: "cancelled" }))
      .toBe("late_after_cancelled");
    expect(lateArtifactDisposition({ requestStatus: "cancelled" }))
      .toBe("late_after_cancelled");
  });

  it.each([
    ["failed", "late_after_failed"],
    ["blocked", "late_after_blocked"],
    ["refunded", "late_after_refunded"],
    ["unknown", "late_after_unknown"],
  ])("maps the %s terminal status to %s", (status, expected) => {
    expect(lateArtifactDisposition({ attemptStatus: status })).toBe(expected);
    expect(lateArtifactDisposition({ requestStatus: status })).toBe(expected);
  });

  it("returns null while nothing is terminal yet", () => {
    expect(lateArtifactDisposition({ attemptStatus: "running" })).toBeNull();
    expect(lateArtifactDisposition({ requestStatus: "queued" })).toBeNull();
    expect(lateArtifactDisposition({ attemptStatus: "succeeded" })).toBeNull();
    expect(lateArtifactDisposition({})).toBeNull();
  });

  // The Attempt fact is the more specific one: an Attempt can be terminal while
  // its Request is still active.
  it("prefers the Attempt outcome when both ended", () => {
    expect(lateArtifactDisposition({
      requestStatus: "failed",
      attemptStatus: "unknown",
    })).toBe("late_after_unknown");
  });

  it("only emits states the validation authority accepts", () => {
    for (const status of ["cancelled", "failed", "blocked", "refunded", "unknown"]) {
      const state = lateArtifactDisposition({ attemptStatus: status });
      expect(GENERATION_ARTIFACT_VALIDATION_STATES).toContain(state);
    }
  });
});
