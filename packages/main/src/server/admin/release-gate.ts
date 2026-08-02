import { z } from "zod";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "@idream/shared/contracts";
import {
  adminCanaryScenarioPathIsRepresentative,
  adminCanaryScenarioIdSchema,
  requiredAdminCanaryScenarioIds,
} from "./canary";
import { availabilityErrorBudget, evaluateAdminOperationalSlos } from "@idream/shared/admin";

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ed25519SignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/, "signature must be a 64-byte base64url Ed25519 signature");

export const adminEvidenceArtifactSchema = z.object({
  uri: z.string().min(1).refine((value) =>
    /^artifact:\/\/sha256\/[a-f0-9]{64}$/.test(value)
    || /^ipfs:\/\/[A-Za-z0-9]+(?:\/.*)?$/.test(value)
    || /^oci:\/\/.+@sha256:[a-f0-9]{64}$/.test(value),
  "evidence artifact URI must be immutable (artifact://sha256, ipfs://, or oci://@sha256)",
  ),
  contentDigest: sha256DigestSchema,
  collectedAt: z.string().datetime({ offset: true }),
  collector: z.object({
    issuer: z.string().trim().min(1).max(120),
    keyId: z.string().trim().min(1).max(120),
    algorithm: z.literal("Ed25519"),
    signature: ed25519SignatureSchema,
  }).strict(),
}).strict().superRefine((artifact, context) => {
  if (artifact.uri.startsWith("artifact://sha256/") && artifact.uri.slice("artifact://sha256/".length) !== artifact.contentDigest.slice("sha256:".length)) {
    context.addIssue({ code: "custom", path: ["contentDigest"], message: "artifact URI digest must equal contentDigest" });
  }
});

const evidenceResultSchema = z.object({
  status: z.enum(["pass", "fail"]),
  observedAt: z.string().datetime({ offset: true }),
  evidenceRefs: z.array(adminEvidenceArtifactSchema).min(1),
}).strict();

const canarySampleSchema = z.object({
  iteration: z.number().int().nonnegative(),
  scenarioId: adminCanaryScenarioIdSchema,
  name: z.string().min(1),
  method: z.enum(["GET", "POST"]),
  path: z.string().refine((value) => value === "/api/v2/admin" || value.startsWith("/api/v2/admin/"), "sample path must target Admin v2"),
  status: z.number().int().min(100).max(599).nullable(),
  outcome: z.enum(["pass", "unexpected_status", "unavailable", "invalid_response", "dependency_failed"]),
  durationMs: z.number().nonnegative(),
}).strict();

const canaryAuthorityProbeSchema = z.object({
  status: z.enum(["pass", "fail"]),
  checks: z.array(z.object({
    iteration: z.number().int().nonnegative(),
    commandId: z.string().min(1),
    commandStatus: z.string().min(1).nullable(),
    auditRecordId: z.string().min(1).nullable(),
    outboxEventId: z.string().min(1).nullable(),
    outcome: z.enum(["pass", "fail"]),
  }).strict()),
}).strict().superRefine((probe, context) => {
  const passed = probe.checks.length > 0 && probe.checks.every((check) =>
    check.outcome === "pass"
    && check.commandStatus === "succeeded"
    && check.auditRecordId !== null
    && check.outboxEventId !== null
  );
  if ((probe.status === "pass") !== passed) {
    context.addIssue({ code: "custom", path: ["status"], message: "authority probe status must equal its command/Audit/Outbox checks" });
  }
});

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
  authorityProbe: canaryAuthorityProbeSchema.nullable(),
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
  const requiredScenarioIds = requiredAdminCanaryScenarioIds(value.mode);
  const requiredScenarioSet = new Set<string>(requiredScenarioIds);
  const scenarioCounts = requiredScenarioIds.map((scenarioId) =>
    value.samples.filter((sample) => sample.scenarioId === scenarioId).length
  );
  const iterations = scenarioCounts[0] ?? 0;
  if (
    iterations === 0
    || scenarioCounts.some((count) => count !== iterations)
    || value.samples.some((sample) => !requiredScenarioSet.has(sample.scenarioId))
  ) {
    context.addIssue({
      code: "custom",
      path: ["samples"],
      message: `${value.mode} canary samples must cover every required scenario equally: ${requiredScenarioIds.join(", ")}`,
    });
  }
  const expectedByScenario: Readonly<Record<string, { method: "GET" | "POST"; status: number }>> = {
    "read.today": { method: "GET", status: 200 },
    "read.list": { method: "GET", status: 200 },
    "read.detail": { method: "GET", status: 200 },
    "read.search": { method: "GET", status: 200 },
    "write.command.accept": { method: "POST", status: 202 },
    "write.command.replay": { method: "POST", status: 202 },
    "write.command.collision": { method: "POST", status: 409 },
    "write.command.readback": { method: "GET", status: 200 },
    "write.state.readback": { method: "GET", status: 200 },
  };
  for (const [index, sample] of value.samples.entries()) {
    const expected = expectedByScenario[sample.scenarioId];
    if (!expected || sample.method !== expected.method) {
      context.addIssue({ code: "custom", path: ["samples", index, "method"], message: "sample method does not match its fixed scenario" });
    }
    if (sample.outcome === "pass" && sample.status !== expected?.status) {
      context.addIssue({ code: "custom", path: ["samples", index, "status"], message: "passing sample status does not match its fixed scenario" });
    }
    if (!adminCanaryScenarioPathIsRepresentative(sample.scenarioId, sample.path)) {
      context.addIssue({ code: "custom", path: ["samples", index, "path"], message: "sample path does not represent its fixed scenario" });
    }
  }
  const sampleIterations = [...new Set(value.samples.map((sample) => sample.iteration))].sort((left, right) => left - right);
  if (sampleIterations.some((iteration, index) => iteration !== index)) {
    context.addIssue({ code: "custom", path: ["samples"], message: "sample iterations must be contiguous from zero" });
  }
  for (const iteration of sampleIterations) {
    const ids = value.samples.filter((sample) => sample.iteration === iteration).map((sample) => sample.scenarioId);
    const idSet = new Set<string>(ids);
    if (ids.length !== requiredScenarioIds.length || idSet.size !== requiredScenarioIds.length || requiredScenarioIds.some((id) => !idSet.has(id))) {
      context.addIssue({ code: "custom", path: ["samples"], message: `iteration ${iteration} is missing a required scenario` });
    }
  }
  if (value.mode === "read" && value.authorityProbe !== null) {
    context.addIssue({ code: "custom", path: ["authorityProbe"], message: "read canary cannot claim write authority evidence" });
  }
  if (value.mode === "write") {
    if (value.authorityProbe === null) {
      context.addIssue({ code: "custom", path: ["authorityProbe"], message: "write canary requires command/Audit/Outbox authority evidence" });
    } else if (value.authorityProbe.checks.length !== iterations) {
      context.addIssue({ code: "custom", path: ["authorityProbe", "checks"], message: "authority checks must match write iterations" });
    } else {
      for (const check of value.authorityProbe.checks) {
        const samples = value.samples.filter((sample) => sample.iteration === check.iteration);
        const commandReadback = samples.find((sample) => sample.scenarioId === "write.command.readback");
        if (!commandReadback?.path.endsWith(`/commands/${encodeURIComponent(check.commandId)}`)) {
          context.addIssue({ code: "custom", path: ["authorityProbe", "checks"], message: "command readback must target the authority-probed command" });
        }
      }
    }
  }
  const reportPassed = failures === 0 && (value.mode === "read" || value.authorityProbe?.status === "pass");
  if ((value.status === "pass") !== reportPassed) {
    context.addIssue({ code: "custom", path: ["status"], message: "canary status must include HTTP and authority outcomes" });
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

export const ADMIN_RELEASE_DRI_ROLES = [
  "product",
  "engineering",
  "data",
  "design",
  "operations",
  "release",
] as const;
export type AdminReleaseDriRole = (typeof ADMIN_RELEASE_DRI_ROLES)[number];

export const ADMIN_RELEASE_REQUIRED_SIGNOFF_ROLES = [
  "product",
  "engineering",
  "release",
] as const satisfies readonly AdminReleaseDriRole[];

const signoffSchema = z.object({
  actor: z.string().min(1),
  decision: z.enum(["go", "no_go"]),
  signedAt: z.string().datetime({ offset: true }),
  keyId: z.string().trim().min(1).max(120),
  algorithm: z.literal("Ed25519"),
  approvalDigest: sha256DigestSchema,
  signature: ed25519SignatureSchema,
}).strict();

export const adminReleaseGateCoreEvidenceSchema = z.object({
  schemaVersion: z.literal(5),
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
}).strict();

export const adminUnsignedReleaseGateEvidenceSchema = adminReleaseGateCoreEvidenceSchema.extend({
  signoffs: z.object({
    product: signoffSchema,
    engineering: signoffSchema,
    data: signoffSchema.optional(),
    design: signoffSchema.optional(),
    operations: signoffSchema.optional(),
    release: signoffSchema,
  }).strict(),
}).strict().superRefine((evidence, context) => {
  const { signoffs: _, provenance: __, ...core } = evidence as typeof evidence & { provenance?: unknown };
  const approvalDigest = computeAdminReleaseApprovalDigest(core);
  const keyIds = new Set<string>();
  for (const role of ADMIN_RELEASE_DRI_ROLES) {
    const signoff = evidence.signoffs[role];
    if (!signoff) continue;
    if (signoff.approvalDigest !== approvalDigest) {
      context.addIssue({ code: "custom", path: ["signoffs", role, "approvalDigest"], message: "DRI approval digest must bind the canonical release core" });
    }
    if (keyIds.has(signoff.keyId)) {
      context.addIssue({ code: "custom", path: ["signoffs", role, "keyId"], message: "Each DRI role must use an independent key ID" });
    }
    keyIds.add(signoff.keyId);
  }
});

export const adminReleaseGateProvenanceSchema = z.object({
  algorithm: z.literal("Ed25519"),
  keyId: z.string().trim().min(1).max(120),
  signedAt: z.string().datetime({ offset: true }),
  signature: ed25519SignatureSchema,
}).strict();

export const adminReleaseGateEvidenceSchema = adminUnsignedReleaseGateEvidenceSchema.safeExtend({
  provenance: adminReleaseGateProvenanceSchema,
}).strict();

export type AdminReleaseGateEvidence = z.infer<typeof adminReleaseGateEvidenceSchema>;
export type AdminUnsignedReleaseGateEvidence = z.infer<typeof adminUnsignedReleaseGateEvidenceSchema>;
export type AdminReleaseGateCoreEvidence = z.infer<typeof adminReleaseGateCoreEvidenceSchema>;

const trustedPublicKeySchema = z.object({
  keyId: z.string().trim().min(1).max(120),
  publicKeyPem: z.string().min(1),
}).strict();

export const adminReleaseTrustRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  releaseKeys: z.array(trustedPublicKeySchema).min(1),
  collectorKeys: z.array(trustedPublicKeySchema.extend({
    issuer: z.string().trim().min(1).max(120),
  }).strict()).min(1),
  driKeys: z.array(trustedPublicKeySchema.extend({
    role: z.enum(ADMIN_RELEASE_DRI_ROLES),
    actor: z.string().min(1),
  }).strict())
    .min(ADMIN_RELEASE_REQUIRED_SIGNOFF_ROLES.length)
    .max(ADMIN_RELEASE_DRI_ROLES.length),
}).strict().superRefine((registry, context) => {
  const releaseIds = registry.releaseKeys.map((key) => key.keyId);
  if (new Set(releaseIds).size !== releaseIds.length) {
    context.addIssue({ code: "custom", path: ["releaseKeys"], message: "release key IDs must be unique" });
  }
  const collectorIds = registry.collectorKeys.map((key) => `${key.issuer}:${key.keyId}`);
  if (new Set(collectorIds).size !== collectorIds.length) {
    context.addIssue({ code: "custom", path: ["collectorKeys"], message: "collector issuer/key IDs must be unique" });
  }
  const roles = registry.driKeys.map((key) => key.role);
  if (new Set(roles).size !== roles.length) {
    context.addIssue({ code: "custom", path: ["driKeys"], message: "trust registry must contain at most one key for each DRI role" });
  }
  if (ADMIN_RELEASE_REQUIRED_SIGNOFF_ROLES.some((role) => !roles.includes(role))) {
    context.addIssue({ code: "custom", path: ["driKeys"], message: "trust registry must contain Product, Engineering, and Release DRI keys" });
  }
  const driIds = registry.driKeys.map((key) => key.keyId);
  if (new Set(driIds).size !== driIds.length) {
    context.addIssue({ code: "custom", path: ["driKeys"], message: "DRI key IDs must be unique across roles" });
  }
});

export type AdminReleaseTrustRegistry = z.infer<typeof adminReleaseTrustRegistrySchema>;

interface AdminReleaseGateSignatureVerification {
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

function evaluateAdminReleaseGateSemantics(
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
    if (kind === "write" && canary.authorityProbe?.status !== "pass") {
      block("write_canary_authority_probe_failed", "Write canary must prove the canonical Command, Audit, and Outbox records.", "runtime.writeCanary.authorityProbe");
    }
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

const ARTIFACT_SIGNATURE_DOMAIN = "idream.admin.evidence-artifact.v1\0";
const APPROVAL_DIGEST_DOMAIN = "idream.admin.release-approval.v5\0";
const DRI_SIGNATURE_DOMAIN = "idream.admin.release-dri.v1\0";
const SIGNATURE_DOMAIN = "idream.admin.release-gate.v5\0";

type SignatureErrorCode =
  | "evidence_signature_missing"
  | "evidence_signature_key_untrusted"
  | "evidence_signature_invalid"
  | "evidence_signature_trust_unconfigured"
  | "evidence_artifact_key_untrusted"
  | "evidence_artifact_signature_invalid"
  | "dri_signature_key_untrusted"
  | "dri_signature_invalid"
  | "dri_key_reused";

class ReleaseEvidenceSignatureError extends Error {
  constructor(readonly code: SignatureErrorCode, message: string, readonly path = "provenance.signature") {
    super(message);
    this.name = "ReleaseEvidenceSignatureError";
  }
}

type EvidenceArtifactInput = Omit<z.input<typeof adminEvidenceArtifactSchema>, "collector">;

function artifactSigningBytes(
  artifact: EvidenceArtifactInput,
  collector: { readonly issuer: string; readonly keyId: string; readonly algorithm: "Ed25519" },
) {
  return Buffer.from(`${ARTIFACT_SIGNATURE_DOMAIN}${canonicalJson({ artifact, collector })}`, "utf8");
}

export function signAdminEvidenceArtifact(
  artifactInput: EvidenceArtifactInput,
  options: {
    readonly privateKeyPem: string | Buffer;
    readonly issuer: string;
    readonly keyId: string;
  },
) {
  const artifact = z.object({
    uri: adminEvidenceArtifactSchema.shape.uri,
    contentDigest: sha256DigestSchema,
    collectedAt: z.string().datetime({ offset: true }),
  }).strict().parse(artifactInput);
  const collector = {
    issuer: options.issuer.trim(),
    keyId: options.keyId.trim(),
    algorithm: "Ed25519" as const,
  };
  if (!collector.issuer || !collector.keyId) throw new Error("Collector issuer and key ID are required");
  const privateKey = createPrivateKey(requirePemKind(options.privateKeyPem, "PRIVATE"));
  assertEd25519Key(privateKey, "private");
  const signature = sign(null, artifactSigningBytes(artifact, collector), privateKey).toString("base64url");
  return adminEvidenceArtifactSchema.parse({ ...artifact, collector: { ...collector, signature } });
}

export function computeAdminReleaseApprovalDigest(input: unknown) {
  const core = adminReleaseGateCoreEvidenceSchema.parse(input);
  return `sha256:${createHash("sha256").update(`${APPROVAL_DIGEST_DOMAIN}${canonicalJson(core)}`).digest("hex")}`;
}

function driSigningBytes(
  role: AdminReleaseDriRole,
  attestation: Omit<z.infer<typeof signoffSchema>, "signature">,
) {
  return Buffer.from(`${DRI_SIGNATURE_DOMAIN}${canonicalJson({ role, attestation })}`, "utf8");
}

export function signAdminDriApproval(
  coreInput: unknown,
  role: AdminReleaseDriRole,
  options: {
    readonly privateKeyPem: string | Buffer;
    readonly actor: string;
    readonly keyId: string;
    readonly decision?: "go" | "no_go";
    readonly signedAt?: Date;
  },
) {
  const attestation = {
    actor: options.actor,
    decision: options.decision ?? "go" as const,
    signedAt: (options.signedAt ?? new Date()).toISOString(),
    keyId: options.keyId.trim(),
    algorithm: "Ed25519" as const,
    approvalDigest: computeAdminReleaseApprovalDigest(coreInput),
  };
  const privateKey = createPrivateKey(requirePemKind(options.privateKeyPem, "PRIVATE"));
  assertEd25519Key(privateKey, "private");
  const signature = sign(null, driSigningBytes(role, attestation), privateKey).toString("base64url");
  return signoffSchema.parse({ ...attestation, signature });
}

interface ProvenancePayload {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signedAt: string;
}

function signingBytes(
  evidence: AdminUnsignedReleaseGateEvidence,
  provenance: ProvenancePayload,
) {
  return Buffer.from(`${SIGNATURE_DOMAIN}${canonicalJson({ evidence, provenance })}`, "utf8");
}

function normalizedPem(input: string | Buffer) {
  return input.toString().replace(/\r\n/g, "\n").trim();
}

function requirePemKind(input: string | Buffer, kind: "PUBLIC" | "PRIVATE") {
  const pem = normalizedPem(input);
  const expectedHeader = `-----BEGIN ${kind} KEY-----`;
  const expectedFooter = `-----END ${kind} KEY-----`;
  if (!pem.startsWith(`${expectedHeader}\n`) || !pem.endsWith(`\n${expectedFooter}`)) {
    throw new ReleaseEvidenceSignatureError(
      "evidence_signature_invalid",
      `Admin release evidence requires an Ed25519 ${kind.toLowerCase()} SPKI/PKCS8 PEM key`,
    );
  }
  return pem;
}

function assertEd25519Key(key: KeyObject, kind: "public" | "private") {
  if (key.type !== kind || key.asymmetricKeyType !== "ed25519") {
    throw new ReleaseEvidenceSignatureError("evidence_signature_invalid", `Admin release evidence requires an Ed25519 ${kind} key`);
  }
}

function evidenceResults(core: AdminReleaseGateCoreEvidence) {
  return [
    core.truth.metricGoldenDataset,
    core.truth.northStarDecisionConsistent,
    core.workflows.character,
    core.workflows.creative,
    core.workflows.incident,
    core.workflows.case,
    core.workflows.today,
    core.migration.freshDeploy,
    core.migration.repeatDeploy,
    core.migration.currentSnapshotUpgrade,
    core.migration.appRollbackForwardFix,
    core.migration.backfillDryRun,
    core.migration.shadowComparison,
    core.migration.moduleRollback,
    core.permissionsAndAudit.permissionMatrix,
    core.permissionsAndAudit.atomicAuditOutbox,
    core.permissionsAndAudit.highRiskConfirmation,
    core.experience.roleNavigation,
    core.experience.serverQueryAndUrlState,
    core.experience.responsiveCoreFlows,
    core.experience.wcag22AA,
    core.runtime.operationalSlos,
    core.runtime.productionLoad,
    core.runtime.dependencyFailureInjection,
    core.runtime.dispatcherRestartRecovery,
    core.runtime.projectorLagRecovery,
    core.runtime.killSwitchDrill,
    core.runtime.readCanary,
    core.runtime.writeCanary,
  ] as const;
}

function trustedPublicKey(pem: string) {
  const publicKey = createPublicKey(requirePemKind(pem, "PUBLIC"));
  assertEd25519Key(publicKey, "public");
  return publicKey;
}

function verifyArtifactAttestations(
  core: AdminReleaseGateCoreEvidence,
  registry: AdminReleaseTrustRegistry,
) {
  for (const result of evidenceResults(core)) {
    for (const artifact of result.evidenceRefs) {
      const trusted = registry.collectorKeys.find((key) =>
        key.issuer === artifact.collector.issuer && key.keyId === artifact.collector.keyId
      );
      if (!trusted) {
        throw new ReleaseEvidenceSignatureError(
          "evidence_artifact_key_untrusted",
          `Evidence collector ${artifact.collector.issuer}/${artifact.collector.keyId} is not trusted`,
          "evidenceRefs.collector",
        );
      }
      const { collector, ...artifactInput } = artifact;
      const { signature, ...collectorPayload } = collector;
      if (!verify(
        null,
        artifactSigningBytes(artifactInput, collectorPayload),
        trustedPublicKey(trusted.publicKeyPem),
        Buffer.from(signature, "base64url"),
      )) {
        throw new ReleaseEvidenceSignatureError(
          "evidence_artifact_signature_invalid",
          `Evidence artifact ${artifact.uri} did not verify`,
          "evidenceRefs.collector.signature",
        );
      }
    }
  }
}

function verifyDriApprovals(
  evidence: AdminUnsignedReleaseGateEvidence,
  registry: AdminReleaseTrustRegistry,
) {
  const { signoffs, ...core } = evidence;
  const approvalDigest = computeAdminReleaseApprovalDigest(core);
  const fingerprints = new Set<string>();
  for (const role of ADMIN_RELEASE_DRI_ROLES) {
    const attestation = signoffs[role];
    if (!attestation) continue;
    const trusted = registry.driKeys.find((key) =>
      key.role === role && key.actor === attestation.actor && key.keyId === attestation.keyId
    );
    if (!trusted) {
      throw new ReleaseEvidenceSignatureError(
        "dri_signature_key_untrusted",
        `${role} DRI actor/key is not trusted for that role`,
        `signoffs.${role}.keyId`,
      );
    }
    const publicKey = trustedPublicKey(trusted.publicKeyPem);
    const fingerprint = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex");
    if (fingerprints.has(fingerprint)) {
      throw new ReleaseEvidenceSignatureError(
        "dri_key_reused",
        "Each DRI role must be backed by an independent public key",
        `signoffs.${role}.keyId`,
      );
    }
    fingerprints.add(fingerprint);
    const { signature, ...payload } = attestation;
    if (payload.approvalDigest !== approvalDigest || !verify(
      null,
      driSigningBytes(role, payload),
      publicKey,
      Buffer.from(signature, "base64url"),
    )) {
      throw new ReleaseEvidenceSignatureError(
        "dri_signature_invalid",
        `${role} DRI signature did not approve the canonical manifest digest`,
        `signoffs.${role}.signature`,
      );
    }
  }
}

export function signAdminReleaseEvidence(
  input: unknown,
  options: {
    readonly privateKeyPem: string | Buffer;
    readonly keyId: string;
    readonly signedAt?: Date;
  },
): AdminReleaseGateEvidence {
  const evidence = adminUnsignedReleaseGateEvidenceSchema.parse(input);
  const provenance: ProvenancePayload = {
    algorithm: "Ed25519",
    keyId: options.keyId.trim(),
    signedAt: (options.signedAt ?? new Date()).toISOString(),
  };
  if (!provenance.keyId) throw new Error("A trusted release evidence key ID is required");
  const privateKey = createPrivateKey(requirePemKind(options.privateKeyPem, "PRIVATE"));
  assertEd25519Key(privateKey, "private");
  const signature = sign(null, signingBytes(evidence, provenance), privateKey).toString("base64url");
  return adminReleaseGateEvidenceSchema.parse({ ...evidence, provenance: { ...provenance, signature } });
}

function verifyAdminReleaseEvidence(
  input: unknown,
  registryInput: unknown,
) {
  let registry: AdminReleaseTrustRegistry;
  try {
    registry = adminReleaseTrustRegistrySchema.parse(registryInput);
  } catch {
    throw new ReleaseEvidenceSignatureError(
      "evidence_signature_trust_unconfigured",
      "A valid independent release/collector/DRI trust registry is required",
    );
  }
  const raw = input as { provenance?: { signature?: unknown } } | null;
  if (!raw || typeof raw !== "object" || typeof raw.provenance?.signature !== "string") {
    throw new ReleaseEvidenceSignatureError("evidence_signature_missing", "Admin release evidence signature is missing");
  }

  let manifest: AdminReleaseGateEvidence;
  try {
    manifest = adminReleaseGateEvidenceSchema.parse(input);
  } catch {
    throw new ReleaseEvidenceSignatureError("evidence_signature_invalid", "Admin release evidence or signature envelope is malformed");
  }
  const trustedReleaseKey = registry.releaseKeys.find((key) => key.keyId === manifest.provenance.keyId);
  if (!trustedReleaseKey) {
    throw new ReleaseEvidenceSignatureError("evidence_signature_key_untrusted", "Admin release evidence key ID is not trusted by this gate");
  }
  const publicKey = trustedPublicKey(trustedReleaseKey.publicKeyPem);
  const { provenance, ...evidence } = manifest;
  const { signature, ...provenancePayload } = provenance;
  const payload = signingBytes(evidence, provenancePayload);
  if (!verify(null, payload, publicKey, Buffer.from(signature, "base64url"))) {
    throw new ReleaseEvidenceSignatureError("evidence_signature_invalid", "Admin release evidence signature verification failed");
  }
  const { signoffs: _, ...core } = evidence;
  verifyArtifactAttestations(core, registry);
  verifyDriApprovals(evidence, registry);
  return {
    manifest,
    verification: {
      verified: true as const,
      algorithm: "Ed25519" as const,
      keyId: provenance.keyId,
      manifestDigest: createHash("sha256").update(payload).digest("hex"),
    },
  };
}

function blockedSignatureReport(error: ReleaseEvidenceSignatureError) {
  return {
    status: "blocked" as const,
    decisionUse: "blocked" as const,
    blockers: [{ code: error.code, message: error.message, path: error.path }],
    evidence: null,
  };
}

export function evaluateAdminReleaseGate(
  input: unknown,
  options: {
    readonly trustRegistry?: unknown;
    readonly now?: Date;
  },
) {
  try {
    const { manifest, verification } = verifyAdminReleaseEvidence(input, options.trustRegistry);
    return evaluateAdminReleaseGateSemantics(manifest, options.now ?? new Date(), verification);
  } catch (error) {
    if (error instanceof ReleaseEvidenceSignatureError) return blockedSignatureReport(error);
    return blockedSignatureReport(new ReleaseEvidenceSignatureError(
      "evidence_signature_invalid",
      error instanceof Error ? error.message : "Admin release evidence verification failed",
    ));
  }
}
