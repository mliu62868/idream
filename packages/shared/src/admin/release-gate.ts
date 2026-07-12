import { z } from "zod";

const evidenceResultSchema = z.object({
  status: z.enum(["pass", "fail"]),
  observedAt: z.string().datetime({ offset: true }),
  evidenceRefs: z.array(z.string().min(1)).min(1),
}).strict();

const canaryResultSchema = evidenceResultSchema.extend({
  sampleSize: z.number().int().nonnegative(),
}).strict();

const signoffSchema = z.object({
  actor: z.string().min(1),
  decision: z.enum(["go", "no_go"]),
  signedAt: z.string().datetime({ offset: true }),
}).strict();

export const adminReleaseGateEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
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
    productionLoad: evidenceResultSchema,
    dependencyFailureInjection: evidenceResultSchema,
    dispatcherRestartRecovery: evidenceResultSchema,
    projectorLagRecovery: evidenceResultSchema,
    killSwitchDrill: evidenceResultSchema,
    readCanary: canaryResultSchema,
    writeCanary: canaryResultSchema,
    errorBudgetExceeded: z.boolean(),
    legacyTrafficCycles: z.array(z.object({
      cycle: z.string().min(1),
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

export type AdminReleaseGateEvidence = z.infer<typeof adminReleaseGateEvidenceSchema>;

export interface AdminReleaseGateBlocker {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINIMUM_OBSERVATION_MS = 7 * DAY_MS;
const MAXIMUM_MANIFEST_AGE_MS = DAY_MS;

export function evaluateAdminReleaseGate(input: unknown, now = new Date()) {
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

  const namedEvidence: ReadonlyArray<readonly [string, string, { status: "pass" | "fail" }]> = [
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
  }

  if (evidence.runtime.readCanary.sampleSize === 0) block("read_canary_missing_samples", "Read canary must contain real production samples.", "runtime.readCanary.sampleSize");
  if (evidence.runtime.writeCanary.sampleSize === 0) block("write_canary_missing_samples", "Write canary must contain real production samples.", "runtime.writeCanary.sampleSize");
  for (const [kind, canary] of [["read", evidence.runtime.readCanary], ["write", evidence.runtime.writeCanary]] as const) {
    const observedAt = new Date(canary.observedAt).getTime();
    if (observedAt < startedAt.getTime() || observedAt > endedAt.getTime()) {
      block(`${kind}_canary_outside_observation_window`, `${kind} canary evidence must be observed inside the declared production window.`, `runtime.${kind}Canary.observedAt`);
    }
  }
  if (evidence.runtime.errorBudgetExceeded) block("error_budget_exceeded", "The production observation window exceeded its error budget.", "runtime.errorBudgetExceeded");
  if (evidence.runtime.legacyTrafficCycles.slice(-2).some((cycle) => cycle.requests !== 0)) {
    block("legacy_traffic_not_zero", "Legacy v1 traffic must be zero for two consecutive business cycles.", "runtime.legacyTrafficCycles");
  }

  for (const [role, signoff] of Object.entries(evidence.signoffs)) {
    if (signoff.decision !== "go" || new Date(signoff.signedAt).getTime() < endedAt.getTime()) {
      block(`${role}_signoff_missing`, `${role} must sign Go after the observation window completes.`, `signoffs.${role}`);
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
    },
  };
}
