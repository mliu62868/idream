export type DependencyChaosScenarioId =
  | "databaseReconnect"
  | "redisConsumerRecovery"
  | "dispatcherLeaseRecovery"
  | "projectorWatermarkRecovery";

export interface DependencyChaosScenarioReport {
  readonly status: "pass" | "fail";
  readonly durationMs: number;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly error?: string;
}

export interface DependencyChaosReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly environment: "isolated-production-like";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: "pass" | "fail";
  readonly infrastructure: {
    readonly postgres: { readonly isolated: true; readonly restartCount: number };
    readonly redis: { readonly isolated: true; readonly restartCount: number };
  };
  readonly scenarios: Readonly<Record<DependencyChaosScenarioId, DependencyChaosScenarioReport>>;
  readonly assertions: {
    readonly commitBeforeAck: boolean;
    readonly noGhostQueued: boolean;
    readonly providerNotRepeated: boolean;
    readonly singleAudit: boolean;
    readonly singleOutbox: boolean;
    readonly singleReceipt: boolean;
    readonly projectorCaughtUp: boolean;
  };
}

interface TransportRehearsalCheck {
  readonly status: "pass" | "fail";
  readonly observedAt: string;
  readonly scenarioIds: readonly DependencyChaosScenarioId[];
}

export interface DependencyChaosTransportSummary {
  readonly dependencyFailureInjection: TransportRehearsalCheck;
  readonly dispatcherRestartRecovery: TransportRehearsalCheck;
  readonly projectorLagRecovery: TransportRehearsalCheck;
}

export interface DependencyChaosHarnessOptions {
  readonly postgresBin?: string;
  readonly initdbBin?: string;
  readonly redisServerBin?: string;
}

function statusOf(
  report: DependencyChaosReport,
  scenarioIds: readonly DependencyChaosScenarioId[],
): "pass" | "fail" {
  return scenarioIds.every((scenarioId) => report.scenarios[scenarioId].status === "pass")
    ? "pass"
    : "fail";
}

function all(condition: boolean, scenarioStatus: "pass" | "fail"): "pass" | "fail" {
  return condition && scenarioStatus === "pass" ? "pass" : "fail";
}

export function summarizeDependencyChaosReadiness(
  report: DependencyChaosReport,
): DependencyChaosTransportSummary {
  const dependencyScenarioIds = ["databaseReconnect", "redisConsumerRecovery"] as const;
  const dispatcherScenarioIds = ["dispatcherLeaseRecovery"] as const;
  const projectorScenarioIds = ["projectorWatermarkRecovery"] as const;
  return {
    dependencyFailureInjection: {
      status: all(
        report.assertions.commitBeforeAck &&
          report.assertions.noGhostQueued &&
          report.assertions.providerNotRepeated &&
          report.assertions.singleAudit &&
          report.assertions.singleOutbox &&
          report.assertions.singleReceipt,
        statusOf(report, dependencyScenarioIds),
      ),
      observedAt: report.endedAt,
      scenarioIds: [...dependencyScenarioIds],
    },
    dispatcherRestartRecovery: {
      status: all(
        report.assertions.singleAudit && report.assertions.singleOutbox,
        statusOf(report, dispatcherScenarioIds),
      ),
      observedAt: report.endedAt,
      scenarioIds: [...dispatcherScenarioIds],
    },
    projectorLagRecovery: {
      status: all(
        report.assertions.projectorCaughtUp && report.assertions.singleReceipt,
        statusOf(report, projectorScenarioIds),
      ),
      observedAt: report.endedAt,
      scenarioIds: [...projectorScenarioIds],
    },
  };
}
