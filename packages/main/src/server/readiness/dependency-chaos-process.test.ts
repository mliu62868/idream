import { describe, expect, it } from "vitest";
import { runDependencyChaosHarness } from "./dependency-chaos-process";
import { summarizeDependencyChaosReadiness } from "./dependency-chaos";

describe("dependency chaos infrastructure failures", () => {
  it("returns a machine-readable fail-closed report when a required process cannot start", async () => {
    const report = await runDependencyChaosHarness({ initdbBin: "idream-missing-initdb-binary" });

    expect(report.status).toBe("fail");
    expect(report.scenarios.databaseReconnect).toMatchObject({
      status: "fail",
      error: expect.stringContaining("infrastructure_setup_failed"),
    });
    expect(summarizeDependencyChaosReadiness(report)).toMatchObject({
      dependencyFailureInjection: { status: "fail" },
      dispatcherRestartRecovery: { status: "fail" },
      projectorLagRecovery: { status: "fail" },
    });
  });
});

describe.runIf(process.env.RUN_ADMIN_DEPENDENCY_CHAOS === "1")(
  "isolated Postgres and Redis dependency failure injection",
  () => {
    it("recovers every durable side effect after real dependency and process restarts", async () => {
      const report = await runDependencyChaosHarness();

      expect(report.status, JSON.stringify(report, null, 2)).toBe("pass");
      expect(report.infrastructure).toEqual({
        postgres: { isolated: true, restartCount: 1 },
        redis: { isolated: true, restartCount: 1 },
      });
      expect(report.assertions).toEqual({
        commitBeforeAck: true,
        noGhostQueued: true,
        providerNotRepeated: true,
        singleAudit: true,
        singleOutbox: true,
        singleReceipt: true,
        projectorCaughtUp: true,
      });
      expect(summarizeDependencyChaosReadiness(report)).toMatchObject({
        dependencyFailureInjection: { status: "pass" },
        dispatcherRestartRecovery: { status: "pass" },
        projectorLagRecovery: { status: "pass" },
      });
    }, 30_000);
  },
);
