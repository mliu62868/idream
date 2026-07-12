import { z } from "zod";
import { availabilityErrorBudget, evaluateAdminOperationalSlos } from "./operational-slo";

const evidenceResultSchema = z.object({
  status: z.enum(["pass", "fail"]),
  observedAt: z.string().datetime({ offset: true }),
  evidenceRefs: z.array(z.string().min(1)).min(1),
}).strict();

const canarySampleSchema = z.object({
  name: z.string().min(1),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().refine((value) => value === "/api/v2/admin" || value.startsWith("/api/v2/admin/"), "sample path must target Admin v2"),
  status: z.number().int().min(100).max(599).nullable(),
  outcome: z.enum(["pass", "unexpected_status", "unavailable"]),
  durationMs: z.number().nonnegative(),
}).strict();

const canaryResultSchema = evidenceResultSchema.extend({
  mode: z.enum(["read", "write"]),
  environment: z.literal("production"),
  runId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  sampleSize: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  availability: z.number().min(0).max(1),
  p95Ms: z.number().nonnegative().nullable(),
  samples: z.array(canarySampleSchema),
}).strict().superRefine((value, context) => {
  const failures = value.samples.filter((sample) => sample.outcome !== "pass").length;
  if (value.sampleSize !== value.samples.length) {
    context.addIssue({ code: "custom", path: ["sampleSize"], message: "sampleSize must equal samples.length" });
  }
  if (value.failures !== failures) {
    context.addIssue({ code: "custom", path: ["failures"], message: "failures must equal non-pass samples" });
  }
  const expectedAvailability = value.samples.length === 0 ? 0 : (value.samples.length - failures) / value.samples.length;
  if (Math.abs(value.availability - expectedAvailability) > Number.EPSILON) {
    context.addIssue({ code: "custom", path: ["availability"], message: "availability must equal the sample outcomes" });
  }
  const sortedDurations = value.samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const expectedP95 = sortedDurations[Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1)] ?? null;
  if (value.p95Ms !== expectedP95) {
    context.addIssue({ code: "custom", path: ["p95Ms"], message: "p95Ms must equal the sample durations" });
  }
});

const operationalSloEvidenceSchema = evidenceResultSchema.extend({
  observations: z.object({
    list_api_p95: z.number().nonnegative(),
    detail_api_p95: z.number().nonnegative(),
    today_api_p95: z.number().nonnegative(),
    command_accept_p95: z.number().nonnegative(),
    global_search_p95: z.number().nonnegative(),
    outbox_lag_p95: z.number().nonnegative(),
    incident_detection_lag: z.number().nonnegative(),
    operational_health_freshness: z.number().nonnegative(),
    cohort_dashboard_freshness: z.number().nonnegative(),
    state_invariant_violations: z.number().int().nonnegative(),
    generation_unknown_failure_rate: z.number().min(0).max(1),
  }).strict(),
}).strict();

const errorBudgetEvidenceSchema = z.object({
  total: z.number().int().positive(),
  failures: z.number().int().nonnegative(),
  targetAvailability: z.literal(0.99),
}).strict().refine((value) => value.failures <= value.total, {
  message: "failures cannot exceed total requests",
  path: ["failures"],
});

const signoffSchema = z.object({
  actor: z.string().min(1),
  decision: z.enum(["go", "no_go"]),
  signedAt: z.string().datetime({ offset: true }),
}).strict();

export const adminUnsignedReleaseGateEvidenceSchema = z.object({
  schemaVersion: z.literal(3),
  environment: z.enum(["local", "staging", "production"]),
  generatedAt: z.string().datetime({ offset: true }),
  observationWindow: z.object({
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }),
  }).strict(),
  truth: z.object({
    stateInvariantViolations: z.number().int().nonnegative(),
    unavailableInvariantChecks: z.number().int().nonnegative(),
    unknownShadowMismatches: z.number().int().nonnegative(),
    metricGoldenDataset: evidenceResultSchema,
    northStarDecisionConsistent: evidenceResultSchema,
  }).strict(),
  workflows: z.object({
    character: evidenceResultSchema,
    creative: evidenceResultSchema,
    incident: evidenceResultSchema,
    case: evidenceResultSchema,
    today: evidenceResultSchema,
  }).strict(),
  migration: z.object({
    freshDeploy: evidenceResultSchema,
    repeatDeploy: evidenceResultSchema,
    currentSnapshotUpgrade: evidenceResultSchema,
    appRollbackForwardFix: evidenceResultSchema,
    backfillDryRun: evidenceResultSchema,
    shadowComparison: evidenceResultSchema,
    moduleRollback: evidenceResultSchema,
  }).strict(),
  permissionsAndAudit: z.object({
    permissionMatrix: evidenceResultSchema,
    atomicAuditOutbox: evidenceResultSchema,
    highRiskConfirmation: evidenceResultSchema,
  }).strict(),
  experience: z.object({
    roleNavigation: evidenceResultSchema,
    serverQueryAndUrlState: evidenceResultSchema,
    responsiveCoreFlows: evidenceResultSchema,
    wcag22AA: evidenceResultSchema,
  }).strict(),
  runtime: z.object({
    operationalSlos: operationalSloEvidenceSchema,
    productionLoad: evidenceResultSchema,
    dependencyFailureInjection: evidenceResultSchema,
    dispatcherRestartRecovery: evidenceResultSchema,
    projectorLagRecovery: evidenceResultSchema,
    killSwitchDrill: evidenceResultSchema,
    readCanary: canaryResultSchema,
    writeCanary: canaryResultSchema,
    errorBudget: errorBudgetEvidenceSchema,
    legacyTrafficCycles: z.array(z.object({
      cycle: z.string().min(1),
      startedAt: z.string().datetime({ offset: true }),
      endedAt: z.string().datetime({ offset: true }),
      requests: z.number().int().nonnegative(),
    }).strict()).min(2),
  }).strict(),
  signoffs: z.object({
    product: signoffSchema,
    engineering: signoffSchema,
    data: signoffSchema,
    design: signoffSchema,
    operations: signoffSchema,
    release: signoffSchema,
  }).strict(),
}).strict();

export const adminReleaseGateProvenanceSchema = z.object({
  algorithm: z.literal("Ed25519"),
  keyId: z.string().trim().min(1).max(120),
  signedAt: z.string().datetime({ offset: true }),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, "signature must be a 64-byte base64url Ed25519 signature"),
}).strict();

export const adminReleaseGateEvidenceSchema = adminUnsignedReleaseGateEvidenceSchema.extend({
  provenance: adminReleaseGateProvenanceSchema,
}).strict();

export type AdminReleaseGateEvidence = z.infer<typeof adminReleaseGateEvidenceSchema>;
export type AdminUnsignedReleaseGateEvidence = z.infer<typeof adminUnsignedReleaseGateEvidenceSchema>;

export interface AdminReleaseGateSignatureVerification {
  readonly verified: true;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly manifestDigest: string;
}

export interface AdminReleaseGateBlocker {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINIMUM_OBSERVATION_MS = 7 * DAY_MS;
const MAXIMUM_MANIFEST_AGE_MS = DAY_MS;

export function evaluateAdminReleaseGate(
  input: unknown,
  now = new Date(),
  signatureVerification?: AdminReleaseGateSignatureVerification,
) {
  const parsed = adminReleaseGateEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "blocked" as const,
      decisionUse: "blocked" as const,
      blockers: [{
        code: "evidence_schema_invalid",
        message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      }],
      evidence: null,
    };
  }

  const evidence = parsed.data;
  const blockers: AdminReleaseGateBlocker[] = [];
  const block = (code: string, message: string, path?: string) => blockers.push({ code, message, ...(path ? { path } : {}) });
  const generatedAt = new Date(evidence.generatedAt);
  const startedAt = new Date(evidence.observationWindow.startedAt);
  const endedAt = new Date(evidence.observationWindow.endedAt);
  if (
    !signatureVerification
    || signatureVerification.algorithm !== evidence.provenance.algorithm
    || signatureVerification.keyId !== evidence.provenance.keyId
  ) {
    block("evidence_signature_unverified", "Final release evidence must be verified against an independently trusted Ed25519 public key.", "provenance.signature");
  }
  const signedAt = new Date(evidence.provenance.signedAt).getTime();
  if (signedAt < generatedAt.getTime() || signedAt > now.getTime()) {
    block("evidence_signature_time_invalid", "Evidence must be signed after manifest generation and no later than evaluation time.", "provenance.signedAt");
  }

  if (evidence.environment !== "production") {
    block("production_evidence_required", "Local or staging evidence cannot authorize production cutover.", "environment");
  }
  if (startedAt.getTime() >= endedAt.getTime() || endedAt.getTime() - startedAt.getTime() < MINIMUM_OBSERVATION_MS) {
    block("observation_window_too_short", "The final cutover observation window must cover at least seven complete days.", "observationWindow");
  }
  if (endedAt.getTime() > generatedAt.getTime()) {
    block("observation_window_incomplete", "The evidence manifest was generated before the observation window ended.", "observationWindow.endedAt");
  }
  const manifestAge = now.getTime() - generatedAt.getTime();
  if (manifestAge < 0) {
    block("evidence_manifest_from_future", "The evidence manifest timestamp is in the future.", "generatedAt");
  } else if (manifestAge > MAXIMUM_MANIFEST_AGE_MS) {
    block("evidence_manifest_stale", "The final release manifest must be regenerated from production within 24 hours.", "generatedAt");
  }

  if (evidence.truth.stateInvariantViolations > 0) block("state_invariant_violation", "All P0 state invariants must be zero.", "truth.stateInvariantViolations");
  if (evidence.truth.unavailableInvariantChecks > 0) block("invariant_check_unavailable", "Unavailable invariant checks block cutover.", "truth.unavailableInvariantChecks");
  if (evidence.truth.unknownShadowMismatches > 0) block("unknown_shadow_mismatch", "Unknown shadow mismatches must be zero.", "truth.unknownShadowMismatches");

  const namedEvidence: ReadonlyArray<readonly [string, string, { status: "pass" | "fail"; observedAt: string }]> = [
    ["metric_golden_dataset_failed", "truth.metricGoldenDataset", evidence.truth.metricGoldenDataset],
    ["north_star_decision_inconsistent", "truth.northStarDecisionConsistent", evidence.truth.northStarDecisionConsistent],
    ["workflow_character_failed", "workflows.character", evidence.workflows.character],
    ["workflow_creative_failed", "workflows.creative", evidence.workflows.creative],
    ["workflow_incident_failed", "workflows.incident", evidence.workflows.incident],
    ["workflow_case_failed", "workflows.case", evidence.workflows.case],
    ["workflow_today_failed", "workflows.today", evidence.workflows.today],
    ["migration_fresh_deploy_failed", "migration.freshDeploy", evidence.migration.freshDeploy],
    ["migration_repeat_deploy_failed", "migration.repeatDeploy", evidence.migration.repeatDeploy],
    ["migration_snapshot_upgrade_failed", "migration.currentSnapshotUpgrade", evidence.migration.currentSnapshotUpgrade],
    ["migration_app_rollback_forward_fix_failed", "migration.appRollbackForwardFix", evidence.migration.appRollbackForwardFix],
    ["migration_backfill_dry_run_failed", "migration.backfillDryRun", evidence.migration.backfillDryRun],
    ["migration_shadow_comparison_failed", "migration.shadowComparison", evidence.migration.shadowComparison],
    ["migration_module_rollback_failed", "migration.moduleRollback", evidence.migration.moduleRollback],
    ["permission_matrix_failed", "permissionsAndAudit.permissionMatrix", evidence.permissionsAndAudit.permissionMatrix],
    ["atomic_audit_outbox_failed", "permissionsAndAudit.atomicAuditOutbox", evidence.permissionsAndAudit.atomicAuditOutbox],
    ["high_risk_confirmation_failed", "permissionsAndAudit.highRiskConfirmation", evidence.permissionsAndAudit.highRiskConfirmation],
    ["role_navigation_failed", "experience.roleNavigation", evidence.experience.roleNavigation],
    ["server_query_url_state_failed", "experience.serverQueryAndUrlState", evidence.experience.serverQueryAndUrlState],
    ["responsive_core_flows_failed", "experience.responsiveCoreFlows", evidence.experience.responsiveCoreFlows],
    ["wcag_22_aa_failed", "experience.wcag22AA", evidence.experience.wcag22AA],
    ["operational_slo_evidence_failed", "runtime.operationalSlos", evidence.runtime.operationalSlos],
    ["production_load_failed", "runtime.productionLoad", evidence.runtime.productionLoad],
    ["dependency_failure_injection_failed", "runtime.dependencyFailureInjection", evidence.runtime.dependencyFailureInjection],
    ["dispatcher_restart_recovery_failed", "runtime.dispatcherRestartRecovery", evidence.runtime.dispatcherRestartRecovery],
    ["projector_lag_recovery_failed", "runtime.projectorLagRecovery", evidence.runtime.projectorLagRecovery],
    ["kill_switch_drill_failed", "runtime.killSwitchDrill", evidence.runtime.killSwitchDrill],
    ["read_canary_failed", "runtime.readCanary", evidence.runtime.readCanary],
    ["write_canary_failed", "runtime.writeCanary", evidence.runtime.writeCanary],
  ];
  for (const [code, path, result] of namedEvidence) {
    if (result.status !== "pass") block(code, `${path} did not pass.`, path);
    const observedAt = new Date(result.observedAt).getTime();
    if (observedAt < startedAt.getTime() || observedAt > endedAt.getTime()) {
      const observationCode = code.replace(/_(failed|inconsistent)$/, "");
      block(`${observationCode}_outside_observation_window`, `${path} evidence must be observed inside the declared production window.`, `${path}.observedAt`);
    }
  }

  if (evidence.runtime.readCanary.sampleSize === 0) block("read_canary_missing_samples", "Read canary must contain real production samples.", "runtime.readCanary.sampleSize");
  if (evidence.runtime.writeCanary.sampleSize === 0) block("write_canary_missing_samples", "Write canary must contain real production samples.", "runtime.writeCanary.sampleSize");
  for (const [kind, canary] of [["read", evidence.runtime.readCanary], ["write", evidence.runtime.writeCanary]] as const) {
    if (canary.mode !== kind) block(`${kind}_canary_mode_mismatch`, `${kind} canary evidence must come from a ${kind} canary run.`, `runtime.${kind}Canary.mode`);
    if (canary.failures > 0 || canary.failures > canary.sampleSize) block(`${kind}_canary_has_failures`, `${kind} canary evidence must have zero failed samples.`, `runtime.${kind}Canary.failures`);
    if (canary.availability !== 1) block(`${kind}_canary_availability_below_gate`, `${kind} canary availability must be 100% for the bounded release drill.`, `runtime.${kind}Canary.availability`);
    if (canary.p95Ms === null) block(`${kind}_canary_latency_missing`, `${kind} canary must contain a measured p95 latency.`, `runtime.${kind}Canary.p95Ms`);
    const runStartedAt = new Date(canary.startedAt).getTime();
    const runEndedAt = new Date(canary.endedAt).getTime();
    if (runStartedAt > runEndedAt || canary.observedAt !== canary.endedAt) {
      block(`${kind}_canary_run_window_invalid`, `${kind} canary start/end/observed timestamps are inconsistent.`, `runtime.${kind}Canary`);
    }
    const observedAt = new Date(canary.observedAt).getTime();
    if (observedAt < startedAt.getTime() || observedAt > endedAt.getTime()) {
      block(`${kind}_canary_outside_observation_window`, `${kind} canary evidence must be observed inside the declared production window.`, `runtime.${kind}Canary.observedAt`);
    }
  }
  const operationalSloReport = evaluateAdminOperationalSlos(evidence.runtime.operationalSlos.observations);
  if (operationalSloReport.status !== "pass") {
    const failedChecks = operationalSloReport.checks.filter((check) => check.status !== "pass").map((check) => check.key).join(", ");
    block("operational_slo_breach", `Section 22 operational SLOs did not pass: ${failedChecks}.`, "runtime.operationalSlos.observations");
  }
  const errorBudget = availabilityErrorBudget(evidence.runtime.errorBudget);
  if (errorBudget.exhausted) block("error_budget_exceeded", "The production observation window exceeded its error budget.", "runtime.errorBudget");
  const legacyCycles = evidence.runtime.legacyTrafficCycles.slice(-2);
  if (legacyCycles.some((cycle) => cycle.requests !== 0)) {
    block("legacy_traffic_not_zero", "Legacy v1 traffic must be zero for two consecutive business cycles.", "runtime.legacyTrafficCycles");
  }
  for (const [index, cycle] of legacyCycles.entries()) {
    const cycleStartedAt = new Date(cycle.startedAt).getTime();
    const cycleEndedAt = new Date(cycle.endedAt).getTime();
    if (cycleStartedAt >= cycleEndedAt || cycleStartedAt < startedAt.getTime() || cycleEndedAt > endedAt.getTime()) {
      block("legacy_traffic_cycle_outside_observation_window", "Each zero-traffic business cycle must be a complete interval inside the production observation window.", `runtime.legacyTrafficCycles.${index}`);
    }
  }
  if (legacyCycles[0] && legacyCycles[1] && new Date(legacyCycles[0].endedAt).getTime() > new Date(legacyCycles[1].startedAt).getTime()) {
    block("legacy_traffic_cycles_overlap", "The two zero-traffic business cycles must be distinct and chronologically ordered.", "runtime.legacyTrafficCycles");
  }
  if (new Set(legacyCycles.map((cycle) => cycle.cycle)).size !== legacyCycles.length) {
    block("legacy_traffic_cycles_duplicate", "The two zero-traffic business cycles must have distinct identities.", "runtime.legacyTrafficCycles");
  }

  for (const [role, signoff] of Object.entries(evidence.signoffs)) {
    const signedAt = new Date(signoff.signedAt).getTime();
    if (signoff.decision !== "go" || signedAt < endedAt.getTime()) {
      block(`${role}_signoff_missing`, `${role} must sign Go after the observation window completes.`, `signoffs.${role}`);
    }
    if (signedAt > generatedAt.getTime() || signedAt > now.getTime()) {
      block(`${role}_signoff_from_future`, `${role} sign-off cannot postdate the evidence manifest or current evaluation time.`, `signoffs.${role}.signedAt`);
    }
  }

  return {
    status: blockers.length === 0 ? "pass" as const : "blocked" as const,
    decisionUse: blockers.length === 0 ? "allowed" as const : "blocked" as const,
    blockers,
    evidence: {
      environment: evidence.environment,
      generatedAt: evidence.generatedAt,
      observationWindow: evidence.observationWindow,
      provenance: {
        algorithm: evidence.provenance.algorithm,
        keyId: evidence.provenance.keyId,
        signedAt: evidence.provenance.signedAt,
        manifestDigest: signatureVerification?.manifestDigest ?? null,
      },
    },
  };
}
