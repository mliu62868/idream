import { describe, expect, it } from "vitest";
import { evaluateAdminReleaseGate, type AdminReleaseGateEvidence } from "./release-gate";

const evidence = (status: "pass" | "fail" = "pass") => ({
  status,
  observedAt: "2026-07-10T00:00:00.000Z",
  evidenceRefs: ["run://admin-readiness/evidence"],
});

function productionEvidence(): AdminReleaseGateEvidence {
  return {
    schemaVersion: 1 as const,
    environment: "production" as const,
    generatedAt: "2026-07-11T00:00:00.000Z",
    observationWindow: {
      startedAt: "2026-07-03T00:00:00.000Z",
      endedAt: "2026-07-10T00:00:00.000Z",
    },
    truth: {
      stateInvariantViolations: 0,
      unavailableInvariantChecks: 0,
      unknownShadowMismatches: 0,
      metricGoldenDataset: evidence(),
      northStarDecisionConsistent: evidence(),
    },
    workflows: {
      character: evidence(),
      creative: evidence(),
      incident: evidence(),
      case: evidence(),
      today: evidence(),
    },
    migration: {
      freshDeploy: evidence(),
      repeatDeploy: evidence(),
      currentSnapshotUpgrade: evidence(),
      appRollbackForwardFix: evidence(),
      backfillDryRun: evidence(),
      shadowComparison: evidence(),
      moduleRollback: evidence(),
    },
    permissionsAndAudit: {
      permissionMatrix: evidence(),
      atomicAuditOutbox: evidence(),
      highRiskConfirmation: evidence(),
    },
    experience: {
      roleNavigation: evidence(),
      serverQueryAndUrlState: evidence(),
      responsiveCoreFlows: evidence(),
      wcag22AA: evidence(),
    },
    runtime: {
      productionLoad: evidence(),
      dependencyFailureInjection: evidence(),
      dispatcherRestartRecovery: evidence(),
      projectorLagRecovery: evidence(),
      killSwitchDrill: evidence(),
      readCanary: { ...evidence(), sampleSize: 1_000 },
      writeCanary: { ...evidence(), sampleSize: 100 },
      errorBudgetExceeded: false,
      legacyTrafficCycles: [
        { cycle: "2026-W27", requests: 0 },
        { cycle: "2026-W28", requests: 0 },
      ],
    },
    signoffs: {
      product: { actor: "product-dri", decision: "go" as const, signedAt: "2026-07-10T12:00:00.000Z" },
      engineering: { actor: "engineering-dri", decision: "go" as const, signedAt: "2026-07-10T12:00:00.000Z" },
      data: { actor: "data-dri", decision: "go" as const, signedAt: "2026-07-10T12:00:00.000Z" },
      design: { actor: "design-dri", decision: "go" as const, signedAt: "2026-07-10T12:00:00.000Z" },
      operations: { actor: "operations-dri", decision: "go" as const, signedAt: "2026-07-10T12:00:00.000Z" },
      release: { actor: "release-dri", decision: "go" as const, signedAt: "2026-07-10T12:00:00.000Z" },
    },
  };
}

describe("Admin final release gate", () => {
  it("passes only with a complete seven-day production evidence window", () => {
    expect(evaluateAdminReleaseGate(productionEvidence(), new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "pass",
      decisionUse: "allowed",
      blockers: [],
    });
  });

  it("blocks local evidence even when every local check is green", () => {
    const input = { ...productionEvidence(), environment: "local" as const };
    expect(evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "blocked",
      decisionUse: "blocked",
      blockers: expect.arrayContaining([expect.objectContaining({ code: "production_evidence_required" })]),
    });
  });

  it("blocks non-zero shadow truth, missing canary samples, legacy traffic, and short observation", () => {
    const input = productionEvidence();
    input.observationWindow.startedAt = "2026-07-09T00:00:00.000Z";
    input.truth.unknownShadowMismatches = 1;
    input.runtime.writeCanary.sampleSize = 0;
    input.runtime.readCanary.observedAt = "2026-07-02T00:00:00.000Z";
    input.runtime.legacyTrafficCycles[1]!.requests = 2;
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.status).toBe("blocked");
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "observation_window_too_short",
      "unknown_shadow_mismatch",
      "write_canary_missing_samples",
      "read_canary_outside_observation_window",
      "legacy_traffic_not_zero",
    ]));
  });

  it("blocks stale manifests, failed named evidence, exhausted budgets, and no-go signoff", () => {
    const input = productionEvidence();
    input.generatedAt = "2026-07-01T00:00:00.000Z";
    input.workflows.case = evidence("fail");
    input.runtime.errorBudgetExceeded = true;
    input.signoffs.operations.decision = "no_go";
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "evidence_manifest_stale",
      "workflow_case_failed",
      "error_budget_exceeded",
      "operations_signoff_missing",
    ]));
  });

  it("blocks evidence and signoffs that claim to occur after the manifest was generated", () => {
    const input = productionEvidence();
    input.workflows.character.observedAt = "2026-07-12T00:00:00.000Z";
    input.signoffs.product.signedAt = "2026-07-12T00:00:00.000Z";
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "workflow_character_evidence_from_future",
      "product_signoff_missing",
    ]));
  });

  it("requires the two zero-traffic business cycles to be distinct", () => {
    const input = productionEvidence();
    input.runtime.legacyTrafficCycles = [
      { cycle: "2026-W28", requests: 0 },
      { cycle: "2026-W28", requests: 0 },
    ];
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "legacy_traffic_cycles_not_distinct" }),
    ]));
  });

  it("fails closed on malformed evidence instead of throwing", () => {
    expect(evaluateAdminReleaseGate({ environment: "production" }, new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "blocked",
      decisionUse: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_schema_invalid" })],
    });
  });
});
