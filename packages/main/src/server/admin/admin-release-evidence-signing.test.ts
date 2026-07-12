import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADMIN_RELEASE_DRI_ROLES,
  evaluateAdminReleaseGate,
  signAdminDriApproval,
  signAdminEvidenceArtifact,
  signAdminReleaseEvidence,
  type AdminReleaseDriRole,
} from "@idream/shared/admin/release-gate";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

const collector = keyPair();
const dri = Object.fromEntries(ADMIN_RELEASE_DRI_ROLES.map((role) => [role, keyPair()])) as Record<AdminReleaseDriRole, ReturnType<typeof keyPair>>;
const digest = "c".repeat(64);

const observed = () => ({
  status: "pass" as const,
  observedAt: "2026-07-10T00:00:00.000Z",
  evidenceRefs: [signAdminEvidenceArtifact({
    uri: `artifact://sha256/${digest}`,
    contentDigest: `sha256:${digest}`,
    collectedAt: "2026-07-10T00:00:00.000Z",
  }, {
    privateKeyPem: collector.privateKeyPem,
    issuer: "main-release-collector",
    keyId: "collector-q3",
  })],
});

function canary(mode: "read" | "write") {
  const durationMs = mode === "read" ? 420 : 610;
  const samples = mode === "read" ? [
    { iteration: 0, scenarioId: "read.today" as const, name: "Today", method: "GET" as const, path: "/api/v2/admin/today", status: 200, outcome: "pass" as const, durationMs },
    { iteration: 0, scenarioId: "read.list" as const, name: "List", method: "GET" as const, path: "/api/v2/admin/cases", status: 200, outcome: "pass" as const, durationMs },
    { iteration: 0, scenarioId: "read.detail" as const, name: "Detail", method: "GET" as const, path: "/api/v2/admin/cases/rehearsal", status: 200, outcome: "pass" as const, durationMs },
    { iteration: 0, scenarioId: "read.search" as const, name: "Search", method: "GET" as const, path: "/api/v2/admin/search?q=canary", status: 200, outcome: "pass" as const, durationMs },
  ] : [
    { iteration: 0, scenarioId: "write.command.accept" as const, name: "Accept", method: "POST" as const, path: "/api/v2/admin/cases/rehearsal/commands/close", status: 202, outcome: "pass" as const, durationMs },
    { iteration: 0, scenarioId: "write.command.replay" as const, name: "Replay", method: "POST" as const, path: "/api/v2/admin/cases/rehearsal/commands/close", status: 202, outcome: "pass" as const, durationMs },
    { iteration: 0, scenarioId: "write.command.collision" as const, name: "Collision", method: "POST" as const, path: "/api/v2/admin/cases/rehearsal/commands/close", status: 409, outcome: "pass" as const, durationMs },
    { iteration: 0, scenarioId: "write.command.readback" as const, name: "Command", method: "GET" as const, path: "/api/v2/admin/commands/canary-command", status: 200, outcome: "pass" as const, durationMs },
    { iteration: 0, scenarioId: "write.state.readback" as const, name: "State", method: "GET" as const, path: "/api/v2/admin/cases/rehearsal", status: 200, outcome: "pass" as const, durationMs },
  ];
  return {
    ...observed(),
    mode,
    environment: "production" as const,
    runId: mode === "read" ? "13d64d65-962a-4a24-8ac1-490404a25581" : "a9399d08-9112-4a57-8e88-3382e8bf89c8",
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:00:00.000Z",
    sampleSize: samples.length,
    failures: 0,
    availability: 1,
    p95Ms: durationMs,
    samples,
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
  };
}

function coreEvidence() {
  return {
    schemaVersion: 5 as const,
    environment: "production" as const,
    generatedAt: "2026-07-11T00:00:00.000Z",
    observationWindow: { startedAt: "2026-07-03T00:00:00.000Z", endedAt: "2026-07-10T00:00:00.000Z" },
    truth: {
      stateInvariantViolations: 0,
      unavailableInvariantChecks: 0,
      unknownShadowMismatches: 0,
      metricGoldenDataset: observed(),
      northStarDecisionConsistent: observed(),
    },
    workflows: { character: observed(), creative: observed(), incident: observed(), case: observed(), today: observed() },
    migration: {
      freshDeploy: observed(), repeatDeploy: observed(), currentSnapshotUpgrade: observed(),
      appRollbackForwardFix: observed(), backfillDryRun: observed(), shadowComparison: observed(), moduleRollback: observed(),
    },
    permissionsAndAudit: { permissionMatrix: observed(), atomicAuditOutbox: observed(), highRiskConfirmation: observed() },
    experience: { roleNavigation: observed(), serverQueryAndUrlState: observed(), responsiveCoreFlows: observed(), wcag22AA: observed() },
    runtime: {
      operationalSlos: {
        ...observed(),
        observations: {
          list_api_p95: 0.4, detail_api_p95: 0.6, today_api_p95: 0.8, command_accept_p95: 0.6,
          global_search_p95: 0.7, outbox_lag_p95: 30, incident_detection_lag: 120,
          operational_health_freshness: 60, cohort_dashboard_freshness: 600,
          state_invariant_violations: 0, generation_unknown_failure_rate: 0.01,
        },
      },
      productionLoad: observed(), dependencyFailureInjection: observed(), dispatcherRestartRecovery: observed(),
      projectorLagRecovery: observed(), killSwitchDrill: observed(), readCanary: canary("read"), writeCanary: canary("write"),
      errorBudget: { total: 100_000, failures: 100, targetAvailability: 0.99 as const },
      legacyTrafficCycles: [
        { cycle: "2026-W27", startedAt: "2026-07-03T00:00:00.000Z", endedAt: "2026-07-06T00:00:00.000Z", requests: 0 },
        { cycle: "2026-W28", startedAt: "2026-07-06T00:00:00.000Z", endedAt: "2026-07-10T00:00:00.000Z", requests: 0 },
      ],
    },
  };
}

function signedEvidence(releaseKeys = keyPair()) {
  const core = coreEvidence();
  const signoffs = Object.fromEntries(ADMIN_RELEASE_DRI_ROLES.map((role) => [role, signAdminDriApproval(core, role, {
    privateKeyPem: dri[role].privateKeyPem,
    actor: `${role}-dri`,
    keyId: `${role}-q3`,
    signedAt: new Date("2026-07-10T12:00:00.000Z"),
  })]));
  return {
    releaseKeys,
    signed: signAdminReleaseEvidence({ ...core, signoffs }, {
      privateKeyPem: releaseKeys.privateKeyPem,
      keyId: "release-2026-q3",
      signedAt: new Date("2026-07-11T00:00:00.000Z"),
    }),
  };
}

function trustRegistry(releasePublicKeyPem: string) {
  return {
    schemaVersion: 1 as const,
    releaseKeys: [{ keyId: "release-2026-q3", publicKeyPem: releasePublicKeyPem }],
    collectorKeys: [{ issuer: "main-release-collector", keyId: "collector-q3", publicKeyPem: collector.publicKeyPem }],
    driKeys: ADMIN_RELEASE_DRI_ROLES.map((role) => ({ role, actor: `${role}-dri`, keyId: `${role}-q3`, publicKeyPem: dri[role].publicKeyPem })),
  };
}

describe("signed Admin release evidence", () => {
  it("passes only when the complete manifest has a valid trusted Ed25519 signature", () => {
    const { releaseKeys, signed } = signedEvidence();
    expect(JSON.stringify(signed)).not.toMatch(/PRIVATE KEY|PUBLIC KEY/);
    expect(evaluateAdminReleaseGate(signed, {
      trustRegistry: trustRegistry(releaseKeys.publicKeyPem),
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "pass", decisionUse: "allowed", blockers: [] });
  });

  it("fails closed when signed evidence is tampered with", () => {
    const { releaseKeys, signed } = signedEvidence();
    signed.truth.stateInvariantViolations = 1;
    expect(evaluateAdminReleaseGate(signed, {
      trustRegistry: trustRegistry(releaseKeys.publicKeyPem),
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })] });
  });

  it("fails closed for a wrong trusted key, missing signature, or untrusted key id", () => {
    const signer = keyPair();
    const wrong = keyPair();
    const { signed } = signedEvidence(signer);
    expect(evaluateAdminReleaseGate(signed, {
      trustRegistry: trustRegistry(wrong.publicKeyPem),
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })] });
    expect(evaluateAdminReleaseGate(signed, {
      trustRegistry: trustRegistry(signer.privateKeyPem),
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })] });
    expect(evaluateAdminReleaseGate({ ...signed, provenance: undefined }, {
      trustRegistry: trustRegistry(signer.publicKeyPem),
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_missing" })] });
    const untrusted = trustRegistry(signer.publicKeyPem);
    untrusted.releaseKeys[0]!.keyId = "other-key";
    expect(evaluateAdminReleaseGate(signed, {
      trustRegistry: untrusted,
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_key_untrusted" })] });
  });
});
