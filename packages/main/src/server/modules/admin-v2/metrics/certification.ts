import type { MetricDefinition } from "@idream/shared/admin";

export const REQUIRED_METRIC_QUALITY_CHECKS = [
  "metrics.server_outcome_completeness",
  "metrics.duplicate_effect",
  "metrics.impossible_state",
  "metrics.fixture_internal_leakage",
  "metrics.authoritative_join_coverage",
  "metrics.event_lag_p95",
  "metrics.eligible_fact_presence",
] as const;

export interface CertificationEvidence {
  definitionSnapshot: {
    queryHash: string;
    definitionMatches: boolean;
    qualityState: string;
    effectiveAt: Date;
    lastValidatedAt: Date | null;
    hasEvidence: boolean;
  } | null;
  qualityChecks: ReadonlyMap<string, {
    status: string;
    checkedAt: Date;
    hasEvidence: boolean;
  }>;
  metricSnapshot: {
    definitionQueryHash: string;
    qualityState: string;
    publicationStatus: string;
    asOf: Date;
    latestDataAt: Date | null;
    hasEvidence: boolean;
    dataValid: boolean;
  } | null;
  sourceFacts: ReadonlyMap<string, { count: number; latestDataAt: Date | null }>;
}

export interface MetricCertification {
  qualityState: "certified" | "directional" | "invalid" | "stale";
  decisionUse: "allowed" | "directional_only" | "blocked";
  latestDataAt: Date | null;
  evidence: readonly string[];
}

export function evaluateMetricCertification(input: {
  definition: MetricDefinition;
  asOf: Date;
  evidence: CertificationEvidence;
  requireMetricSnapshot?: boolean;
}): MetricCertification {
  const failures: string[] = [];
  const definitionSnapshot = input.evidence.definitionSnapshot;
  if (!definitionSnapshot) failures.push("definition_snapshot_missing");
  else {
    if (definitionSnapshot.queryHash !== input.definition.queryHash) failures.push("definition_query_hash_mismatch");
    if (!definitionSnapshot.definitionMatches) failures.push("definition_snapshot_mismatch");
    if (definitionSnapshot.effectiveAt > input.asOf) failures.push("definition_snapshot_not_effective");
    if (definitionSnapshot.qualityState !== "certified" && definitionSnapshot.qualityState !== "directional") {
      failures.push("definition_not_certified");
    }
    if (!definitionSnapshot.lastValidatedAt) failures.push("definition_validation_timestamp_missing");
    if (!definitionSnapshot.hasEvidence) failures.push("definition_validation_evidence_missing");
  }

  for (const checkKey of REQUIRED_METRIC_QUALITY_CHECKS) {
    const check = input.evidence.qualityChecks.get(checkKey);
    if (!check) {
      failures.push(`quality_check_missing:${checkKey}`);
      continue;
    }
    if (check.status !== "passed") failures.push(`quality_check_${check.status}:${checkKey}`);
    if (!check.hasEvidence) failures.push(`quality_check_evidence_missing:${checkKey}`);
    if (input.asOf.getTime() - check.checkedAt.getTime() > input.definition.freshnessSlo.maxAgeSeconds * 1_000) {
      failures.push(`quality_check_stale:${checkKey}`);
    }
  }

  const requiredLatest: Date[] = [];
  for (const sourceFact of input.definition.sourceFacts) {
    const source = input.evidence.sourceFacts.get(sourceFact);
    if (!source || source.count === 0 || !source.latestDataAt) {
      failures.push(`source_fact_missing:${sourceFact}`);
      continue;
    }
    requiredLatest.push(source.latestDataAt);
    if (input.asOf.getTime() - source.latestDataAt.getTime() > input.definition.freshnessSlo.maxAgeSeconds * 1_000) {
      failures.push(`source_fact_stale:${sourceFact}`);
    }
  }
  const latestDataAt = requiredLatest.length === input.definition.sourceFacts.length
    ? new Date(Math.min(...requiredLatest.map((date) => date.getTime())))
    : null;

  if (input.requireMetricSnapshot !== false) {
    const snapshot = input.evidence.metricSnapshot;
    if (!snapshot) failures.push("metric_snapshot_missing");
    else {
      if (snapshot.definitionQueryHash !== input.definition.queryHash) failures.push("metric_snapshot_query_hash_mismatch");
      if (snapshot.qualityState !== "certified" && snapshot.qualityState !== "directional") failures.push("metric_snapshot_not_certified");
      if (snapshot.publicationStatus !== input.definition.publicationStatus) failures.push("metric_snapshot_publication_mismatch");
      if (!snapshot.hasEvidence) failures.push("metric_snapshot_evidence_missing");
      if (!snapshot.dataValid) failures.push("metric_snapshot_data_invalid");
      if (!snapshot.latestDataAt) failures.push("metric_snapshot_latest_data_missing");
      if (snapshot.asOf > input.asOf) failures.push("metric_snapshot_from_future");
      if (snapshot.latestDataAt && latestDataAt && snapshot.latestDataAt.getTime() !== latestDataAt.getTime()) {
        failures.push("metric_snapshot_source_freshness_mismatch");
      }
      if (input.asOf.getTime() - snapshot.asOf.getTime() > input.definition.freshnessSlo.maxAgeSeconds * 1_000) {
        failures.push("metric_snapshot_stale");
      }
    }
  }

  if (failures.length > 0) {
    const stale = failures.every((failure) => failure.includes("stale"));
    return { qualityState: stale ? "stale" : "invalid", decisionUse: "blocked", latestDataAt, evidence: failures };
  }
  const directional = input.definition.publicationStatus === "shadow"
    || definitionSnapshot?.qualityState === "directional"
    || input.evidence.metricSnapshot?.qualityState === "directional";
  return {
    qualityState: directional ? "directional" : "certified",
    decisionUse: directional ? "directional_only" : "allowed",
    latestDataAt,
    evidence: [
      "persisted_definition_snapshot_verified",
      "required_quality_checks_passed",
      "required_source_facts_fresh",
      ...(input.requireMetricSnapshot === false ? [] : ["metric_snapshot_verified"]),
    ],
  };
}
