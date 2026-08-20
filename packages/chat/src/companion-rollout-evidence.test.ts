import { describe, expect, it, vi } from "vitest";
import type { ChatPrismaClient } from "./db.js";
import {
  collectCompanionRolloutEvidence,
  summarizeCompanionRolloutEvidence,
} from "./companion-rollout-evidence.js";

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
            sidecar: {
              instanceId: "11111111-1111-4111-8111-111111111111",
              startedAt: "2026-08-19T02:59:00.000Z",
              profileDigest: "d".repeat(64),
            },
            igrep: {
              search: {
                calls: 1,
                hit: 1,
                empty: 0,
                failure: 0,
                resultCount: 2,
                latencyMs: [12],
              },
              memory: {
                calls: 1,
                hit: 0,
                empty: 0,
                failure: 1,
                resultCount: 0,
                latencyMs: [20],
              },
            },
          },
          memoryExtracted: false,
        },
        {
          telemetry: {
            schemaVersion: 1,
            runtime: "dsh",
            startedAt: "2026-08-19T04:00:00.000Z",
            firstTokenMs: 18,
            totalMs: 180,
            terminalStatus: "sent",
            truncated: false,
            provider: "openrouter",
            model: "deepseek/dsh",
            steps: 1,
            toolCalls: 0,
            retryCount: 0,
            sseTerminal: "done",
            memory: { outcome: "ingested", settleLagMs: 30 },
            sidecar: {
              instanceId: "22222222-2222-4222-8222-222222222222",
              startedAt: "2026-08-19T03:59:00.000Z",
              profileDigest: "e".repeat(64),
            },
            igrep: {
              search: {
                calls: 1,
                hit: 0,
                empty: 1,
                failure: 0,
                resultCount: 0,
                latencyMs: [8],
              },
            },
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
      providerCost: {
        status: "insufficient",
        samples: 0,
        totalMicros: null,
        reason: "provider_cost_not_reported_by_companion_upstream",
      },
    });
    expect(result.runtimes.dsh).toMatchObject({
      attempts: 2,
      rates: { error: 0.5, truncated: 0.5, cancelled: 0 },
      memory: {
        outcomes: { failed: 1, ingested: 1 },
        settleLagMs: { samples: 2, p50: 35, p95: 39.5 },
      },
      sseIncomplete: 1,
      sidecar: {
        status: "observed",
        sampledAttempts: 2,
        distinctInstances: 2,
        instanceTransitions: 1,
        restartRatePerHour: 0.041667,
      },
      igrep: {
        status: "observed",
        search: {
          calls: 2,
          hit: 1,
          empty: 1,
          failure: 0,
          resultCount: 2,
          latencyMs: { samples: 2, p50: 10, p95: 11.8 },
        },
        memory: {
          calls: 1,
          hit: 0,
          empty: 0,
          failure: 1,
          resultCount: 0,
          latencyMs: { samples: 1, p50: 20, p95: 20 },
        },
      },
      providerCost: {
        status: "insufficient",
        samples: 0,
        totalMicros: null,
        reason: "provider_cost_not_reported_by_companion_upstream",
      },
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

  it("does not infer igrep observation from sidecar identity without a real operation", () => {
    const attempts = [1, 2].map((index) => ({
      telemetry: {
        schemaVersion: 1 as const,
        runtime: "dsh" as const,
        startedAt: `2026-08-19T0${index}:00:00.000Z`,
        retryCount: 0,
        sidecar: {
          instanceId: "11111111-1111-4111-8111-111111111111",
          startedAt: "2026-08-19T00:59:00.000Z",
          profileDigest: "d".repeat(64),
        },
      },
      memoryExtracted: false,
    }));
    const result = summarizeCompanionRolloutEvidence({
      window: {
        from: new Date("2026-08-19T00:00:00.000Z"),
        to: new Date("2026-08-20T00:00:00.000Z"),
      },
      attempts,
      outbox: [],
    });

    expect(result.runtimes.dsh.igrep).toMatchObject({
      status: "insufficient",
      reason: "igrep_operation_not_observed",
      search: { calls: 0, latencyMs: { samples: 0 } },
      memory: { calls: 0, latencyMs: { samples: 0 } },
    });
  });

  it("reports historical native memory extraction as unknown", () => {
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
            retryCount: 0,
            memory: { outcome: "pending" },
          },
          memoryExtracted: null,
        },
      ],
      outbox: [],
    });

    expect(result.runtimes.native.memory.outcomes).toEqual({ unknown: 1 });
  });

  it("fails the evidence window closed when any selected telemetry row is malformed", async () => {
    const valid = {
      schemaVersion: 1,
      runtime: "dsh",
      startedAt: "2026-08-19T01:00:00.000Z",
      retryCount: 0,
      sidecar: {
        instanceId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-19T00:59:00.000Z",
        profileDigest: "d".repeat(64),
      },
    };
    const prisma = {
      $queryRaw: vi.fn(async () => [
        { telemetry: valid, memoryExtracted: false },
        { telemetry: { ...valid, startedAt: "2026-08-19T02:00:00.000Z" }, memoryExtracted: false },
        { telemetry: { ...valid, startedAt: "2026-08-19T03:00:00.000Z" }, memoryExtracted: false },
        { telemetry: { ...valid, startedAt: "2026-08-19T04:00:00.000Z" }, memoryExtracted: false },
        { telemetry: null, memoryExtracted: false },
      ]),
    } as unknown as ChatPrismaClient;

    await expect(collectCompanionRolloutEvidence({
      window: {
        from: new Date("2026-08-19T00:00:00.000Z"),
        to: new Date("2026-08-20T00:00:00.000Z"),
      },
    }, prisma)).rejects.toThrow("telemetry row failed schema validation");
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const query = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      strings?: readonly string[];
    };
    const sql = query.strings?.join("?") ?? "";
    expect(sql).toContain("m.reply_to_message_id IS NOT NULL");
    expect(sql).not.toContain("jsonb_typeof");
    expect(sql).not.toContain("primaryTelemetry') ->> 'runtime' IN");
  });
});
