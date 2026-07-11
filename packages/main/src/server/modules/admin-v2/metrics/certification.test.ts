import { describe, expect, it } from "vitest";
import { ADMIN_METRIC_REGISTRY } from "@idream/shared/admin";
import { evaluateMetricCertification, REQUIRED_METRIC_QUALITY_CHECKS, type CertificationEvidence } from "./certification";

const definition = ADMIN_METRIC_REGISTRY.find((row) => row.key === "north_star.wpcu")!;
const asOf = new Date("2026-08-01T12:00:00.000Z");

function validEvidence(): CertificationEvidence {
  const fresh = new Date(asOf.getTime() - 30_000);
  return {
    definitionSnapshot: {
      queryHash: definition.queryHash,
      definitionMatches: true,
      qualityState: "certified",
      effectiveAt: new Date("2026-07-11T00:00:00.000Z"),
      lastValidatedAt: fresh,
      hasEvidence: true,
    },
    qualityChecks: new Map(REQUIRED_METRIC_QUALITY_CHECKS.map((key) => [key, {
      status: "passed",
      checkedAt: fresh,
      hasEvidence: true,
    }])),
    metricSnapshot: {
      definitionQueryHash: definition.queryHash,
      qualityState: "certified",
      publicationStatus: definition.publicationStatus,
      asOf: fresh,
      latestDataAt: fresh,
      hasEvidence: true,
      dataValid: true,
    },
    sourceFacts: new Map(definition.sourceFacts.map((key) => [key, { count: 1, latestDataAt: fresh }])),
  };
}

describe("metric certification authority", () => {
  it("fails closed for an empty database authority", () => {
    const result = evaluateMetricCertification({
      definition,
      asOf,
      evidence: { definitionSnapshot: null, qualityChecks: new Map(), metricSnapshot: null, sourceFacts: new Map() },
    });
    expect(result).toMatchObject({ qualityState: "invalid", decisionUse: "blocked", latestDataAt: null });
    expect(result.evidence).toContain("definition_snapshot_missing");
    expect(result.evidence).toContain("metric_snapshot_missing");
  });

  it("does not let a fresh source hide a stalled required source", () => {
    const evidence = validEvidence();
    const stalled = definition.sourceFacts[0];
    evidence.sourceFacts = new Map(evidence.sourceFacts).set(
      stalled,
      { count: 1, latestDataAt: new Date(asOf.getTime() - 2 * 60 * 60 * 1_000) },
    );
    const result = evaluateMetricCertification({ definition, asOf, evidence });
    expect(result).toMatchObject({ qualityState: "invalid", decisionUse: "blocked" });
    expect(result.evidence).toContain(`source_fact_stale:${stalled}`);
  });

  it("requires the persisted metric snapshot and all evidence", () => {
    const evidence = validEvidence();
    evidence.metricSnapshot = null;
    const result = evaluateMetricCertification({ definition, asOf, evidence });
    expect(result).toMatchObject({ qualityState: "invalid", decisionUse: "blocked" });
    expect(result.evidence).toContain("metric_snapshot_missing");
  });

  it("blocks apparently passed rows whose audit evidence is empty", () => {
    const evidence = validEvidence();
    if (evidence.definitionSnapshot) evidence.definitionSnapshot.hasEvidence = false;
    const firstCheck = REQUIRED_METRIC_QUALITY_CHECKS[0];
    evidence.qualityChecks = new Map(evidence.qualityChecks).set(firstCheck, {
      status: "passed",
      checkedAt: new Date(asOf.getTime() - 30_000),
      hasEvidence: false,
    });
    const result = evaluateMetricCertification({ definition, asOf, evidence });
    expect(result).toMatchObject({ qualityState: "invalid", decisionUse: "blocked" });
    expect(result.evidence).toContain("definition_validation_evidence_missing");
    expect(result.evidence).toContain(`quality_check_evidence_missing:${firstCheck}`);
  });
});
