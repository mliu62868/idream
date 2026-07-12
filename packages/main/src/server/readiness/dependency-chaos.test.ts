import { describe, expect, it } from "vitest";
import {
  summarizeDependencyChaosReadiness,
  type DependencyChaosReport,
} from "./dependency-chaos";

describe("dependency failure-injection readiness", () => {
  it("fails closed unless every dependency, dispatcher, and projector invariant passed", () => {
    const report = {
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      environment: "isolated-production-like",
      startedAt: "2026-07-12T00:00:00.000Z",
      endedAt: "2026-07-12T00:01:00.000Z",
      status: "fail",
      infrastructure: {
        postgres: { isolated: true, restartCount: 1 },
        redis: { isolated: true, restartCount: 1 },
      },
      scenarios: {
        databaseReconnect: { status: "pass", durationMs: 10, checks: { reconnected: true } },
        redisConsumerRecovery: { status: "pass", durationMs: 10, checks: { noGhostQueued: true } },
        dispatcherLeaseRecovery: { status: "pass", durationMs: 10, checks: { singleAudit: true } },
        projectorWatermarkRecovery: { status: "fail", durationMs: 10, checks: { watermarkCaughtUp: false } },
      },
      assertions: {
        commitBeforeAck: true,
        noGhostQueued: true,
        providerNotRepeated: true,
        singleAudit: true,
        singleOutbox: true,
        singleReceipt: true,
        projectorCaughtUp: false,
      },
    } satisfies DependencyChaosReport;

    expect(summarizeDependencyChaosReadiness(report)).toEqual({
      dependencyFailureInjection: {
        status: "pass",
        observedAt: "2026-07-12T00:01:00.000Z",
        scenarioIds: ["databaseReconnect", "redisConsumerRecovery"],
      },
      dispatcherRestartRecovery: {
        status: "pass",
        observedAt: "2026-07-12T00:01:00.000Z",
        scenarioIds: ["dispatcherLeaseRecovery"],
      },
      projectorLagRecovery: {
        status: "fail",
        observedAt: "2026-07-12T00:01:00.000Z",
        scenarioIds: ["projectorWatermarkRecovery"],
      },
    });
  });

  it("does not publish passing release candidates when a cross-scenario invariant is false", () => {
    const report = {
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000002",
      environment: "isolated-production-like",
      startedAt: "2026-07-12T00:00:00.000Z",
      endedAt: "2026-07-12T00:01:00.000Z",
      status: "fail",
      infrastructure: {
        postgres: { isolated: true, restartCount: 1 },
        redis: { isolated: true, restartCount: 1 },
      },
      scenarios: {
        databaseReconnect: { status: "pass", durationMs: 10, checks: { reconnected: true } },
        redisConsumerRecovery: { status: "pass", durationMs: 10, checks: { noGhostQueued: true } },
        dispatcherLeaseRecovery: { status: "pass", durationMs: 10, checks: { singleAudit: true } },
        projectorWatermarkRecovery: { status: "pass", durationMs: 10, checks: { watermarkCaughtUp: true } },
      },
      assertions: {
        commitBeforeAck: true,
        noGhostQueued: true,
        providerNotRepeated: false,
        singleAudit: true,
        singleOutbox: true,
        singleReceipt: true,
        projectorCaughtUp: true,
      },
    } satisfies DependencyChaosReport;

    expect(summarizeDependencyChaosReadiness(report)).toMatchObject({
      dependencyFailureInjection: { status: "fail" },
      dispatcherRestartRecovery: { status: "pass" },
      projectorLagRecovery: { status: "pass" },
    });
  });
});
