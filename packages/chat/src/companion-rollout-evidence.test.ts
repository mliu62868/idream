import { describe, expect, it } from "vitest";
import { summarizeCompanionRolloutEvidence } from "./companion-rollout-evidence.js";

describe("Gate R companion rollout evidence", () => {
  it("aggregates observed native and DSH facts without inventing a release threshold", () => {
    const result = summarizeCompanionRolloutEvidence({
      window: {
        from: new Date("2026-08-19T00:00:00.000Z"),
        to: new Date("2026-08-20T00:00:00.000Z"),
      },
      attempts: [
        {
          telemetry: {
            schemaVersion: 1,
            runtime: "native",
            startedAt: "2026-08-19T01:00:00.000Z",
            firstTokenMs: 10,
            totalMs: 100,
            terminalStatus: "sent",
            truncated: false,
            provider: "openrouter",
            model: "deepseek/native",
            usage: { promptTokens: 100, completionTokens: 20 },
            steps: 1,
            toolCalls: 0,
            retryCount: 0,
            sseTerminal: "done",
            memory: { outcome: "pending" },
          },
          memoryExtracted: true,
        },
        {
          telemetry: {
            schemaVersion: 1,
            runtime: "native",
            startedAt: "2026-08-19T02:00:00.000Z",
            firstTokenMs: 30,
            totalMs: 300,
            terminalStatus: "failed",
            truncated: false,
            provider: "openrouter",
            model: "deepseek/native",
            steps: 2,
            toolCalls: 1,
            retryCount: 1,
            sseTerminal: "error",
            memory: { outcome: "not_started" },
            error: { category: "provider", code: "provider_failed" },
          },
          memoryExtracted: false,
        },
        {
          telemetry: {
            schemaVersion: 1,
            runtime: "dsh",
            startedAt: "2026-08-19T03:00:00.000Z",
            firstTokenMs: 20,
            totalMs: 200,
            terminalStatus: "sent",
            truncated: true,
            provider: "openrouter",
            model: "deepseek/dsh",
            usage: { promptTokens: 80, completionTokens: 10, reasoningTokens: 4 },
            steps: 3,
            toolCalls: 1,
            retryCount: 0,
            memory: { outcome: "failed", settleLagMs: 40 },
            error: { category: "runtime", code: "provider_stream_interrupted" },
          },
          memoryExtracted: false,
        },
      ],
      outbox: [
        { runtime: "native", status: "delivered", deliveryLagMs: 50, pendingAgeMs: null },
        { runtime: "dsh", status: "pending", deliveryLagMs: null, pendingAgeMs: 900 },
      ],
    });

    expect(result.comparisonStatus).toBe("observed");
    expect(result.releaseDecision).toEqual({
      status: "not_evaluated",
      reason: "no_gate_thresholds_or_observation_window_policy",
    });
    expect(result.runtimes.native).toMatchObject({
      attempts: 2,
      terminal: { sent: 1, blocked: 0, failed: 1, cancelled: 0 },
      rates: { error: 0.5, truncated: 0, cancelled: 0 },
      firstTokenMs: { samples: 2, p50: 20, p95: 29 },
      totalMs: { samples: 2, p50: 200, p95: 290 },
      steps: { samples: 2, p50: 1.5, p95: 1.95 },
      toolCalls: { samples: 2, p50: 0.5, p95: 0.95 },
      retryCount: { samples: 2, p50: 0.5, p95: 0.95 },
      memory: {
        outcomes: { extracted: 1, not_started: 1 },
        settleLagMs: { samples: 0, p50: null, p95: null },
      },
      casConflicts: 0,
      sseIncomplete: 0,
      outbox: {
        events: 1,
        delivered: 1,
        pending: 0,
        failed: 0,
        deliveryLagMs: { samples: 1, p50: 50, p95: 50 },
        oldestPendingMs: null,
      },
    });
    expect(result.runtimes.dsh).toMatchObject({
      attempts: 1,
      rates: { error: 1, truncated: 1, cancelled: 0 },
      memory: {
        outcomes: { failed: 1 },
        settleLagMs: { samples: 1, p50: 40, p95: 40 },
      },
      sseIncomplete: 1,
      outbox: {
        events: 1,
        delivered: 0,
        pending: 1,
        oldestPendingMs: 900,
      },
    });
    expect(JSON.stringify(result)).not.toContain("userId");
    expect(JSON.stringify(result)).not.toContain("messageId");
  });

  it("reports a zero-sample comparison as insufficient instead of passing Gate R", () => {
    const result = summarizeCompanionRolloutEvidence({
      window: {
        from: new Date("2026-08-19T00:00:00.000Z"),
        to: new Date("2026-08-20T00:00:00.000Z"),
      },
      attempts: [],
      outbox: [],
    });

    expect(result.comparisonStatus).toBe("sample_insufficient");
    expect(result.sampleEvidence).toEqual({ native: "no_samples", dsh: "no_samples" });
    expect(result.releaseDecision.status).toBe("not_evaluated");
  });
});
