import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADMIN_RELEASE_DRI_ROLES,
  evaluateAdminReleaseGate as evaluateSignedReleaseGate,
  signAdminDriApproval,
  signAdminEvidenceArtifact,
  signAdminReleaseEvidence,
  type AdminReleaseDriRole,
} from "./release-gate";

function pair() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

const releaseKeys = pair();
const collectorKeys = pair();
const driKeys = Object.fromEntries(ADMIN_RELEASE_DRI_ROLES.map((role) => [role, pair()])) as Record<AdminReleaseDriRole, ReturnType<typeof pair>>;
const actors: Record<AdminReleaseDriRole, string> = {
  product: "product-dri",
  engineering: "engineering-dri",
  data: "data-dri",
  design: "design-dri",
  operations: "operations-dri",
  release: "release-dri",
};
const trustRegistry = {
  schemaVersion: 1 as const,
  releaseKeys: [{ keyId: "release-2026-q3", publicKeyPem: releaseKeys.publicKeyPem }],
  collectorKeys: [{ issuer: "admin-readiness-collector", keyId: "collector-2026-q3", publicKeyPem: collectorKeys.publicKeyPem }],
  driKeys: ADMIN_RELEASE_DRI_ROLES.map((role) => ({ role, actor: actors[role], keyId: `${role}-2026-q3`, publicKeyPem: driKeys[role].publicKeyPem })),
};

function seal(core: Record<string, unknown>, signoffClaims?: Record<string, { decision?: "go" | "no_go"; signedAt?: string }>) {
  const signoffs = Object.fromEntries(ADMIN_RELEASE_DRI_ROLES.map((role) => [role, signAdminDriApproval(core, role, {
    privateKeyPem: driKeys[role].privateKeyPem,
    actor: actors[role],
    keyId: `${role}-2026-q3`,
    decision: signoffClaims?.[role]?.decision,
    signedAt: new Date(signoffClaims?.[role]?.signedAt ?? "2026-07-10T12:00:00.000Z"),
  })]));
  return signAdminReleaseEvidence({ ...core, signoffs }, {
    privateKeyPem: releaseKeys.privateKeyPem,
    keyId: "release-2026-q3",
    signedAt: new Date("2026-07-11T00:00:00.000Z"),
  });
}

function coreOf(evidence: ReturnType<typeof signAdminReleaseEvidence>) {
  const { provenance: _, signoffs: __, ...core } = evidence;
  return core;
}

function signoffsFor(core: Record<string, unknown>, privateKeys = driKeys) {
  return Object.fromEntries(ADMIN_RELEASE_DRI_ROLES.map((role) => [role, signAdminDriApproval(core, role, {
    privateKeyPem: privateKeys[role].privateKeyPem,
    actor: actors[role],
    keyId: `${role}-2026-q3`,
    signedAt: new Date("2026-07-10T12:00:00.000Z"),
  })]));
}

function releaseEnvelope(core: Record<string, unknown>, signoffs: Record<string, unknown>) {
  return signAdminReleaseEvidence({ ...core, signoffs }, {
    privateKeyPem: releaseKeys.privateKeyPem,
    keyId: "release-2026-q3",
    signedAt: new Date("2026-07-11T00:00:00.000Z"),
  });
}

function evaluateAdminReleaseGate(input: unknown, now: Date) {
  let candidate = input;
  if (input && typeof input === "object" && "provenance" in input) {
    const { provenance: _, signoffs, ...core } = input as Record<string, unknown>;
    try {
      candidate = seal(core, signoffs as Record<string, { decision?: "go" | "no_go"; signedAt?: string }>);
    } catch {
      candidate = input;
    }
  }
  return evaluateSignedReleaseGate(candidate, {
    trustRegistry,
    now,
  });
}

const artifactDigest = "a".repeat(64);
const evidence = (status: "pass" | "fail" = "pass") => ({
  status,
  observedAt: "2026-07-10T00:00:00.000Z",
  evidenceRefs: [signAdminEvidenceArtifact({
    uri: `artifact://sha256/${artifactDigest}`,
    contentDigest: `sha256:${artifactDigest}`,
    collectedAt: "2026-07-10T00:00:00.000Z",
  }, {
    privateKeyPem: collectorKeys.privateKeyPem,
    issuer: "admin-readiness-collector",
    keyId: "collector-2026-q3",
  })],
});

const canaryEvidence = (mode: "read" | "write") => ({
  ...evidence(),
  mode,
  environment: "production" as const,
  runId: mode === "read" ? "13d64d65-962a-4a24-8ac1-490404a25581" : "a9399d08-9112-4a57-8e88-3382e8bf89c8",
  startedAt: "2026-07-10T00:00:00.000Z",
  endedAt: "2026-07-10T00:00:00.000Z",
  sampleSize: mode === "read" ? 4 : 5,
  failures: 0,
  availability: 1,
  p95Ms: mode === "read" ? 420 : 610,
  samples: mode === "read" ? [
    { iteration: 0, scenarioId: "read.today" as const, name: "Today", method: "GET" as const, path: "/api/v2/admin/today", status: 200, outcome: "pass" as const, durationMs: 420 },
    { iteration: 0, scenarioId: "read.list" as const, name: "Case list", method: "GET" as const, path: "/api/v2/admin/cases?limit=10", status: 200, outcome: "pass" as const, durationMs: 410 },
    { iteration: 0, scenarioId: "read.detail" as const, name: "Case detail", method: "GET" as const, path: "/api/v2/admin/cases/rehearsal", status: 200, outcome: "pass" as const, durationMs: 400 },
    { iteration: 0, scenarioId: "read.search" as const, name: "Search", method: "GET" as const, path: "/api/v2/admin/search?q=canary", status: 200, outcome: "pass" as const, durationMs: 390 },
  ] : [
    { iteration: 0, scenarioId: "write.command.accept" as const, name: "Accept", method: "POST" as const, path: "/api/v2/admin/cases/rehearsal/commands/close", status: 202, outcome: "pass" as const, durationMs: 610 },
    { iteration: 0, scenarioId: "write.command.replay" as const, name: "Replay", method: "POST" as const, path: "/api/v2/admin/cases/rehearsal/commands/close", status: 202, outcome: "pass" as const, durationMs: 600 },
    { iteration: 0, scenarioId: "write.command.collision" as const, name: "Collision", method: "POST" as const, path: "/api/v2/admin/cases/rehearsal/commands/close", status: 409, outcome: "pass" as const, durationMs: 590 },
    { iteration: 0, scenarioId: "write.command.readback" as const, name: "Command readback", method: "GET" as const, path: "/api/v2/admin/commands/canary-command", status: 200, outcome: "pass" as const, durationMs: 580 },
    { iteration: 0, scenarioId: "write.state.readback" as const, name: "State readback", method: "GET" as const, path: "/api/v2/admin/cases/rehearsal", status: 200, outcome: "pass" as const, durationMs: 570 },
  ],
  authorityProbe: mode === "read" ? null : {
    status: "pass" as const,
    checks: [{
      iteration: 0,
      commandId: "canary-command",
      commandStatus: "succeeded",
      auditRecordId: "canary-audit",
      outboxEventId: "canary-outbox",
      outcome: "pass" as const,
    }],
  },
});

function productionEvidence() {
  const core = {
    schemaVersion: 5 as const,
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
      operationalSlos: {
        ...evidence(),
        observations: {
          list_api_p95: 0.4,
          detail_api_p95: 0.6,
          today_api_p95: 0.8,
          command_accept_p95: 0.6,
          global_search_p95: 0.7,
          outbox_lag_p95: 30,
          incident_detection_lag: 120,
          operational_health_freshness: 60,
          cohort_dashboard_freshness: 600,
          state_invariant_violations: 0,
          generation_unknown_failure_rate: 0.01,
        },
      },
      productionLoad: evidence(),
      dependencyFailureInjection: evidence(),
      dispatcherRestartRecovery: evidence(),
      projectorLagRecovery: evidence(),
      killSwitchDrill: evidence(),
      readCanary: canaryEvidence("read"),
      writeCanary: canaryEvidence("write"),
      errorBudget: { total: 100_000, failures: 100, targetAvailability: 0.99 as const },
      legacyTrafficCycles: [
        { cycle: "2026-W27", startedAt: "2026-07-03T00:00:00.000Z", endedAt: "2026-07-06T00:00:00.000Z", requests: 0 },
        { cycle: "2026-W28", startedAt: "2026-07-06T00:00:00.000Z", endedAt: "2026-07-10T00:00:00.000Z", requests: 0 },
      ],
    },
  };
  return seal(core);
}

describe("Admin final release gate", () => {
  it("passes only with a complete seven-day production evidence window", () => {
    expect(evaluateAdminReleaseGate(productionEvidence(), new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "pass",
      decisionUse: "allowed",
      blockers: [],
    });
  });

  it("blocks an unverifiable artifact signature and an untrusted collector issuer", () => {
    const core = coreOf(productionEvidence());
    const artifact = core.truth.metricGoldenDataset.evidenceRefs[0]!;
    core.truth.metricGoldenDataset.evidenceRefs[0] = {
      ...artifact,
      collector: {
        ...artifact.collector,
        signature: `${artifact.collector.signature.startsWith("A") ? "B" : "A"}${artifact.collector.signature.slice(1)}`,
      },
    };
    const invalidArtifact = releaseEnvelope(core, signoffsFor(core));
    expect(evaluateSignedReleaseGate(invalidArtifact, {
      trustRegistry,
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_artifact_signature_invalid" })],
    });

    const wrongIssuerCore = coreOf(productionEvidence());
    wrongIssuerCore.truth.metricGoldenDataset.evidenceRefs[0] = signAdminEvidenceArtifact({
      uri: `artifact://sha256/${artifactDigest}`,
      contentDigest: `sha256:${artifactDigest}`,
      collectedAt: "2026-07-10T00:00:00.000Z",
    }, {
      privateKeyPem: collectorKeys.privateKeyPem,
      issuer: "untrusted-collector",
      keyId: "collector-2026-q3",
    });
    const wrongIssuer = releaseEnvelope(wrongIssuerCore, signoffsFor(wrongIssuerCore));
    expect(evaluateSignedReleaseGate(wrongIssuer, {
      trustRegistry,
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_artifact_key_untrusted" })],
    });
  });

  it("blocks artifact replacement even when every embedded claim still says pass", () => {
    const replaced = productionEvidence();
    const replacementDigest = "b".repeat(64);
    replaced.truth.metricGoldenDataset.evidenceRefs[0] = {
      ...replaced.truth.metricGoldenDataset.evidenceRefs[0]!,
      uri: `artifact://sha256/${replacementDigest}`,
      contentDigest: `sha256:${replacementDigest}`,
    };
    expect(evaluateSignedReleaseGate(replaced, { trustRegistry })).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })],
    });
  });

  it("blocks one private key forging six roles and blocks role-signature reuse", () => {
    const core = coreOf(productionEvidence());
    const forgedKeys = Object.fromEntries(ADMIN_RELEASE_DRI_ROLES.map((role) => [role, releaseKeys])) as Record<AdminReleaseDriRole, ReturnType<typeof pair>>;
    const forged = releaseEnvelope(core, signoffsFor(core, forgedKeys));
    expect(evaluateSignedReleaseGate(forged, { trustRegistry })).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "dri_signature_invalid" })],
    });

    const signoffs = signoffsFor(core) as Record<AdminReleaseDriRole, ReturnType<typeof signAdminDriApproval>>;
    signoffs.engineering = { ...signoffs.engineering, signature: signoffs.product.signature };
    const reused = releaseEnvelope(core, signoffs);
    expect(evaluateSignedReleaseGate(reused, { trustRegistry })).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "dri_signature_invalid" })],
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

  it("blocks non-zero shadow truth, legacy traffic, and a short observation window", () => {
    const input = productionEvidence();
    input.observationWindow.startedAt = "2026-07-09T00:00:00.000Z";
    input.truth.unknownShadowMismatches = 1;
    input.runtime.readCanary.observedAt = "2026-07-02T00:00:00.000Z";
    input.runtime.legacyTrafficCycles[1]!.requests = 2;
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.status).toBe("blocked");
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "observation_window_too_short",
      "unknown_shadow_mismatch",
      "read_canary_outside_observation_window",
      "legacy_traffic_not_zero",
    ]));
  });

  it("rejects a trivial canary that omits any fixed representative scenario", () => {
    const input = productionEvidence();
    input.runtime.readCanary.samples = input.runtime.readCanary.samples.slice(0, 1);
    input.runtime.readCanary.sampleSize = 1;
    input.runtime.readCanary.p95Ms = input.runtime.readCanary.samples[0]!.durationMs;
    expect(evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })],
    });
  });

  it("blocks stale manifests, failed named evidence, exhausted budgets, and no-go signoff", () => {
    const input = productionEvidence();
    input.generatedAt = "2026-07-01T00:00:00.000Z";
    input.workflows.case = evidence("fail");
    input.runtime.errorBudget.failures = 2_000;
    input.signoffs.operations.decision = "no_go";
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "evidence_manifest_stale",
      "workflow_case_failed",
      "error_budget_exceeded",
      "operations_signoff_missing",
    ]));
  });

  it("blocks stale named evidence, future signoffs, and malformed legacy-cycle evidence", () => {
    const input = productionEvidence();
    input.workflows.character.observedAt = "2026-07-02T23:59:59.000Z";
    input.signoffs.release.signedAt = "2026-07-12T00:00:00.000Z";
    input.runtime.legacyTrafficCycles[1]!.startedAt = "2026-07-05T00:00:00.000Z";
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "workflow_character_outside_observation_window",
      "legacy_traffic_cycles_overlap",
      "release_signoff_from_future",
    ]));
  });

  it("accepts direct canary-runner summaries but rejects inconsistent canary evidence", () => {
    const input = productionEvidence();
    expect(evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z")).status).toBe("pass");

    input.runtime.writeCanary.failures = 1;
    input.runtime.writeCanary.availability = 0.8;
    input.runtime.writeCanary.status = "fail";
    input.runtime.writeCanary.samples[0]!.status = 500;
    input.runtime.writeCanary.samples[0]!.outcome = "unexpected_status";
    expect(evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z")).blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "write_canary_has_failures",
      "write_canary_availability_below_gate",
    ]));
  });

  it("computes the section 22 SLO and error-budget gates instead of trusting a pass label", () => {
    const input = productionEvidence();
    input.runtime.operationalSlos.observations.detail_api_p95 = 0.751;
    input.runtime.errorBudget.failures = 1_001;
    const report = evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"));
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "operational_slo_breach",
      "error_budget_exceeded",
    ]));
  });

  it("rejects the superseded release manifest schema", () => {
    const input = { ...productionEvidence(), schemaVersion: 4 };
    expect(evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })],
    });
  });

  it("fails closed when error-budget counts are internally impossible", () => {
    const input = productionEvidence();
    input.runtime.errorBudget.failures = input.runtime.errorBudget.total + 1;
    expect(evaluateAdminReleaseGate(input, new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })],
    });
  });

  it("does not expose a semantic bypass for unsigned evidence", () => {
    const { provenance: _, ...unsigned } = productionEvidence();
    expect(evaluateSignedReleaseGate(unsigned, {
      trustRegistry,
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_signature_missing" })],
    });
  });

  it("fails closed on malformed evidence instead of throwing", () => {
    expect(evaluateAdminReleaseGate({ environment: "production" }, new Date("2026-07-11T00:00:00.000Z"))).toMatchObject({
      status: "blocked",
      decisionUse: "blocked",
      blockers: [expect.objectContaining({ code: "evidence_signature_missing" })],
    });
  });
});
