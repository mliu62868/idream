import { describe, expect, it } from "vitest";
import {
  deriveGenerationJobState,
  deriveGenerationTimeline,
} from "./generation-job-state";

describe("generation job truth derivation", () => {
  it("does not synthesize job.completed for a failed job with legacy completedAt", () => {
    const completedAt = new Date("2026-01-02T03:04:05.000Z");
    const events = [
      {
        createdAt: new Date("2026-01-02T03:04:00.000Z"),
        type: "failed",
        message: "Provider timed out",
        metadata: {},
      },
    ];

    const timeline = deriveGenerationTimeline({
      status: "failed",
      completedAt,
      events,
      moderationEvents: [],
      ledgerEntries: [],
    });
    const state = deriveGenerationJobState({
      status: "failed",
      completedAt,
      errorCode: "provider_timeout",
      assets: [],
      events,
      ledgerEntries: [],
    });

    expect(timeline.map((entry) => entry.type)).toEqual(["failed"]);
    expect(timeline.some((entry) => entry.type === "job.completed")).toBe(false);
    expect(state).toMatchObject({
      executionOutcome: "failed",
      finishedAt: events[0].createdAt,
      terminalSource: "event",
      retryEligibility: { eligible: true },
    });
  });

  it("does not make a failed row retryable when it already has a valid successful artifact", () => {
    const state = deriveGenerationJobState({
      status: "failed",
      completedAt: new Date("2026-01-02T03:04:05.000Z"),
      errorCode: "ingest_timeout",
      assets: [{ id: "asset-1", safetyStatus: "passed", deletedAt: null }],
      events: [],
      ledgerEntries: [],
    });

    expect(state.executionOutcome).toBe("succeeded");
    expect(state.retryEligibility).toEqual({
      eligible: false,
      reason: "successful_artifact_exists",
    });
  });

  it("keeps legacy completed without a success event or artifact unknown", () => {
    const completedAt = new Date("2026-01-02T03:04:05.000Z");
    const state = deriveGenerationJobState({
      status: "completed",
      completedAt,
      errorCode: null,
      assets: [],
      events: [],
      ledgerEntries: [],
    });
    const timeline = deriveGenerationTimeline({
      status: "completed",
      completedAt,
      events: [],
      moderationEvents: [],
      ledgerEntries: [],
    });

    expect(state).toMatchObject({
      executionOutcome: "unknown",
      terminalSource: "legacy_status",
      terminalConflict: false,
    });
    expect(timeline).toEqual([]);
  });

  it("surfaces conflicting completed and failed terminal events instead of choosing a winner", () => {
    const state = deriveGenerationJobState({
      status: "failed",
      completedAt: new Date("2026-01-02T03:04:05.000Z"),
      errorCode: "provider_timeout",
      assets: [],
      events: [
        { createdAt: new Date("2026-01-02T03:04:01.000Z"), type: "completed" },
        { createdAt: new Date("2026-01-02T03:04:02.000Z"), type: "failed" },
      ],
      ledgerEntries: [],
    });

    expect(state).toMatchObject({
      executionOutcome: "unknown",
      terminalSource: "event",
      terminalConflict: true,
      retryEligibility: { eligible: false, reason: "not_failed" },
    });
  });
});
