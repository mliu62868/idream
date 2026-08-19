import { describe, expect, it } from "vitest";
import { recordCompanionOperationalEvent } from "./companion-rollout-telemetry.js";

const common = {
  invocationId: "invocation-1",
  attemptId: "attempt-1",
  sequence: 1,
  occurredAt: "2026-08-19T12:00:00.000Z",
};

describe("companion operational telemetry", () => {
  it("retains only sidecar identity and aggregate igrep outcomes", () => {
    const telemetry = {};
    recordCompanionOperationalEvent(telemetry, {
      ...common,
      type: "started",
      instance: {
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-19T11:59:00.000Z",
      },
      profileDigest: "d".repeat(64),
    });
    recordCompanionOperationalEvent(telemetry, {
      ...common,
      sequence: 2,
      type: "igrep_observation",
      operation: "memory",
      outcome: "hit",
      resultCount: 2,
      durationMs: 12,
    });
    recordCompanionOperationalEvent(telemetry, {
      ...common,
      sequence: 3,
      type: "igrep_observation",
      operation: "memory",
      outcome: "failure",
      durationMs: 20,
    });

    expect(telemetry).toEqual({
      sidecar: {
        instanceId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-19T11:59:00.000Z",
        profileDigest: "d".repeat(64),
      },
      igrep: {
        memory: {
          calls: 2,
          hit: 1,
          empty: 0,
          failure: 1,
          resultCount: 2,
          latencyMs: [12, 20],
        },
      },
    });
    expect(JSON.stringify(telemetry)).not.toContain("invocation-1");
    expect(JSON.stringify(telemetry)).not.toContain("attempt-1");
  });
});
