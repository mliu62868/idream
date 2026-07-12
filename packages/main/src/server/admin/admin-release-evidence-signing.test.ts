import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateSignedAdminReleaseGate,
  signAdminReleaseEvidence,
} from "./admin-release-evidence-signing";

const observed = () => ({
  status: "pass" as const,
  observedAt: "2026-07-10T00:00:00.000Z",
  evidenceRefs: ["run://admin-readiness/evidence"],
});

function canary(mode: "read" | "write") {
  const durationMs = mode === "read" ? 420 : 610;
  return {
    ...observed(),
    mode,
    environment: "production" as const,
    runId: mode === "read" ? "13d64d65-962a-4a24-8ac1-490404a25581" : "a9399d08-9112-4a57-8e88-3382e8bf89c8",
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:00:00.000Z",
    sampleSize: 1,
    failures: 0,
    availability: 1,
    p95Ms: durationMs,
    samples: [{
      name: `${mode} authority`,
      method: mode === "read" ? "GET" as const : "POST" as const,
      path: mode === "read" ? "/api/v2/admin/today" : "/api/v2/admin/cases/rehearsal/commands/close",
      status: mode === "read" ? 200 : 202,
      outcome: "pass" as const,
      durationMs,
    }],
  };
}

function unsignedEvidence() {
  return {
    schemaVersion: 3 as const,
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
    signoffs: Object.fromEntries(["product", "engineering", "data", "design", "operations", "release"].map((role) => [role, {
      actor: `${role}-dri`, decision: "go" as const, signedAt: "2026-07-10T12:00:00.000Z",
    }])) as Record<"product" | "engineering" | "data" | "design" | "operations" | "release", { actor: string; decision: "go"; signedAt: string }>,
  };
}

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

describe("signed Admin release evidence", () => {
  it("passes only when the complete manifest has a valid trusted Ed25519 signature", () => {
    const keys = keyPair();
    const signed = signAdminReleaseEvidence(unsignedEvidence(), {
      privateKeyPem: keys.privateKeyPem,
      keyId: "release-2026-q3",
      signedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(JSON.stringify(signed)).not.toMatch(/PRIVATE KEY|PUBLIC KEY/);
    expect(evaluateSignedAdminReleaseGate(signed, {
      publicKeyPem: keys.publicKeyPem,
      expectedKeyId: "release-2026-q3",
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "pass", decisionUse: "allowed", blockers: [] });
  });

  it("fails closed when signed evidence is tampered with", () => {
    const keys = keyPair();
    const signed = signAdminReleaseEvidence(unsignedEvidence(), {
      privateKeyPem: keys.privateKeyPem,
      keyId: "release-2026-q3",
      signedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    signed.truth.stateInvariantViolations = 1;
    expect(evaluateSignedAdminReleaseGate(signed, {
      publicKeyPem: keys.publicKeyPem,
      expectedKeyId: "release-2026-q3",
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })] });
  });

  it("fails closed for a wrong trusted key, missing signature, or untrusted key id", () => {
    const signer = keyPair();
    const wrong = keyPair();
    const signed = signAdminReleaseEvidence(unsignedEvidence(), {
      privateKeyPem: signer.privateKeyPem,
      keyId: "release-2026-q3",
      signedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(evaluateSignedAdminReleaseGate(signed, {
      publicKeyPem: wrong.publicKeyPem,
      expectedKeyId: "release-2026-q3",
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_invalid" })] });
    expect(evaluateSignedAdminReleaseGate({ ...signed, provenance: undefined }, {
      publicKeyPem: signer.publicKeyPem,
      expectedKeyId: "release-2026-q3",
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_missing" })] });
    expect(evaluateSignedAdminReleaseGate(signed, {
      publicKeyPem: signer.publicKeyPem,
      expectedKeyId: "other-key",
      now: new Date("2026-07-11T00:00:00.000Z"),
    })).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "evidence_signature_key_untrusted" })] });
  });
});
