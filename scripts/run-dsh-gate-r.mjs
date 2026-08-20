#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MIN_ATTEMPTS_PER_RUNTIME = 2;
const RAW_SENSITIVE_KEYS = new Set([
  "authorization",
  "content",
  "messages",
  "memorytext",
  "prompt",
  "rawtrace",
  "runtimetrace",
  "secret",
  "systemprompt",
  "token",
  "toolarguments",
  "transcript",
  "workspace",
]);

class GateRInputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function inputError(code) {
  throw new GateRInputError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!isRecord(value)) inputError("schema_drift");
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) inputError("schema_drift");
  if (Object.keys(value).some((key) => !allowed.has(key))) inputError("schema_drift");
}

function validateNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) inputError("schema_drift");
}

function validateNonNegativeFinite(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    inputError("schema_drift");
  }
}

function validateNullableNonNegativeFinite(value) {
  if (value !== null) validateNonNegativeFinite(value);
}

function isoTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    inputError("schema_drift");
  }
}

function enumValue(value, allowed) {
  if (!allowed.includes(value)) inputError("schema_drift");
}

function validateMetric(value) {
  exactKeys(value, ["samples", "p50", "p95"]);
  validateNonNegativeInteger(value.samples);
  validateNullableNonNegativeFinite(value.p50);
  validateNullableNonNegativeFinite(value.p95);
  if (value.samples === 0) {
    if (value.p50 !== null || value.p95 !== null) inputError("schema_drift");
  } else if (value.p50 === null || value.p95 === null || value.p50 > value.p95) {
    inputError("schema_drift");
  }
}

function validateCounts(value) {
  if (!isRecord(value)) inputError("schema_drift");
  for (const count of Object.values(value)) validateNonNegativeInteger(count);
}

function validateIgrepMetric(value) {
  exactKeys(value, ["calls", "hit", "empty", "failure", "resultCount", "latencyMs"]);
  for (const key of ["calls", "hit", "empty", "failure", "resultCount"]) {
    validateNonNegativeInteger(value[key]);
  }
  validateMetric(value.latencyMs);
  if (value.calls !== value.hit + value.empty + value.failure) inputError("schema_drift");
  if (value.calls !== value.latencyMs.samples) inputError("schema_drift");
}

function validateRuntime(value, runtime) {
  exactKeys(value, [
    "attempts",
    "terminal",
    "rates",
    "firstTokenMs",
    "totalMs",
    "steps",
    "toolCalls",
    "retryCount",
    "usage",
    "providerModels",
    "providerCost",
    "errors",
    "memory",
    "sidecar",
    "igrep",
    "casConflicts",
    "sseIncomplete",
    "outbox",
  ]);
  validateNonNegativeInteger(value.attempts);

  exactKeys(value.terminal, ["sent", "blocked", "failed", "cancelled"]);
  for (const count of Object.values(value.terminal)) validateNonNegativeInteger(count);
  exactKeys(value.rates, ["error", "truncated", "cancelled"]);
  for (const rate of Object.values(value.rates)) {
    validateNullableNonNegativeFinite(rate);
    if (rate !== null && rate > 1) inputError("schema_drift");
  }
  for (const key of ["firstTokenMs", "totalMs", "steps", "toolCalls", "retryCount"]) {
    validateMetric(value[key]);
  }

  exactKeys(value.usage, ["promptTokens", "completionTokens", "reasoningTokens"]);
  validateMetric(value.usage.promptTokens);
  validateMetric(value.usage.completionTokens);
  validateMetric(value.usage.reasoningTokens);

  if (!Array.isArray(value.providerModels)) inputError("schema_drift");
  for (const item of value.providerModels) {
    exactKeys(item, ["provider", "model", "count"]);
    if (typeof item.provider !== "string" || item.provider.length === 0) inputError("schema_drift");
    if (typeof item.model !== "string" || item.model.length === 0) inputError("schema_drift");
    validateNonNegativeInteger(item.count);
  }

  exactKeys(value.providerCost, ["status", "samples", "totalMicros", "reason"]);
  if (
    value.providerCost.status !== "insufficient" ||
    value.providerCost.samples !== 0 ||
    value.providerCost.totalMicros !== null ||
    value.providerCost.reason !== "provider_cost_not_reported_by_companion_upstream"
  ) {
    inputError("schema_drift");
  }

  exactKeys(value.errors, ["byCategory", "byCode"]);
  validateCounts(value.errors.byCategory);
  validateCounts(value.errors.byCode);

  exactKeys(value.memory, ["outcomes", "settleLagMs"]);
  validateCounts(value.memory.outcomes);
  validateMetric(value.memory.settleLagMs);

  exactKeys(
    value.sidecar,
    ["status", "sampledAttempts", "distinctInstances", "instanceTransitions", "restartRatePerHour"],
    ["reason"],
  );
  enumValue(value.sidecar.status, ["not_applicable", "observed", "insufficient"]);
  validateNonNegativeInteger(value.sidecar.sampledAttempts);
  validateNonNegativeInteger(value.sidecar.distinctInstances);
  validateNonNegativeInteger(value.sidecar.instanceTransitions);
  validateNullableNonNegativeFinite(value.sidecar.restartRatePerHour);
  if (Object.hasOwn(value.sidecar, "reason") && typeof value.sidecar.reason !== "string") {
    inputError("schema_drift");
  }

  exactKeys(value.igrep, ["status", "search", "memory"], ["reason"]);
  enumValue(value.igrep.status, ["not_applicable", "observed", "insufficient"]);
  validateIgrepMetric(value.igrep.search);
  validateIgrepMetric(value.igrep.memory);
  if (Object.hasOwn(value.igrep, "reason") && typeof value.igrep.reason !== "string") {
    inputError("schema_drift");
  }

  validateNonNegativeInteger(value.casConflicts);
  validateNonNegativeInteger(value.sseIncomplete);
  exactKeys(value.outbox, [
    "events",
    "delivered",
    "pending",
    "failed",
    "deliveryLagMs",
    "oldestPendingMs",
  ]);
  for (const key of ["events", "delivered", "pending", "failed"]) {
    validateNonNegativeInteger(value.outbox[key]);
  }
  validateMetric(value.outbox.deliveryLagMs);
  validateNullableNonNegativeFinite(value.outbox.oldestPendingMs);

  if (value.attempts === 0) {
    if (Object.values(value.terminal).some((count) => count !== 0)) inputError("schema_drift");
    if (Object.values(value.rates).some((rate) => rate !== null)) inputError("schema_drift");
  }
  if (runtime === "native" && value.sidecar.status !== "not_applicable") inputError("schema_drift");
  if (runtime === "native" && value.igrep.status !== "not_applicable") inputError("schema_drift");
}

function findRawSensitiveKey(value) {
  if (Array.isArray(value)) {
    return value.some((item) => findRawSensitiveKey(item));
  }
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (RAW_SENSITIVE_KEYS.has(key.toLowerCase())) return true;
    if (findRawSensitiveKey(nested)) return true;
  }
  return false;
}

function validateAggregate(aggregate) {
  if (findRawSensitiveKey(aggregate)) inputError("raw_sensitive_key");
  exactKeys(aggregate, [
    "schemaVersion",
    "generatedAt",
    "window",
    "comparisonStatus",
    "sampleEvidence",
    "releaseDecision",
    "runtimes",
    "dataScope",
  ]);
  if (aggregate.schemaVersion !== 1) inputError("schema_drift");
  isoTime(aggregate.generatedAt);

  exactKeys(aggregate.window, ["from", "to", "durationMs"]);
  isoTime(aggregate.window.from);
  isoTime(aggregate.window.to);
  validateNonNegativeInteger(aggregate.window.durationMs);
  const duration = Date.parse(aggregate.window.to) - Date.parse(aggregate.window.from);
  if (duration <= 0 || duration !== aggregate.window.durationMs) inputError("schema_drift");

  enumValue(aggregate.comparisonStatus, ["sample_insufficient", "observed"]);
  exactKeys(aggregate.sampleEvidence, ["native", "dsh"]);
  enumValue(aggregate.sampleEvidence.native, ["no_samples", "observed"]);
  enumValue(aggregate.sampleEvidence.dsh, ["no_samples", "observed"]);
  exactKeys(aggregate.releaseDecision, ["status", "reason"]);
  if (
    aggregate.releaseDecision.status !== "not_evaluated" ||
    aggregate.releaseDecision.reason !== "no_gate_thresholds_or_observation_window_policy"
  ) {
    inputError("schema_drift");
  }

  exactKeys(aggregate.runtimes, ["native", "dsh"]);
  validateRuntime(aggregate.runtimes.native, "native");
  validateRuntime(aggregate.runtimes.dsh, "dsh");
  for (const runtime of ["native", "dsh"]) {
    const expected = aggregate.runtimes[runtime].attempts === 0 ? "no_samples" : "observed";
    if (aggregate.sampleEvidence[runtime] !== expected) inputError("schema_drift");
  }

  exactKeys(aggregate.dataScope, [
    "userAuthority",
    "scope",
    "includedDataClass",
    "activeCustomersOnly",
    "exactAuditActorOnly",
    "userFilterApplied",
    "windowBasis",
  ]);
  const scope = aggregate.dataScope;
  if (
    scope.userAuthority !== "core.chat_user_view" ||
    scope.scope !== "internal-audit" ||
    scope.includedDataClass !== "audit" ||
    scope.activeCustomersOnly !== false ||
    scope.exactAuditActorOnly !== true ||
    scope.userFilterApplied !== true ||
    scope.windowBasis !== "message_versions.created_at"
  ) {
    inputError("invalid_evidence_scope");
  }
}

function readAggregate(filePath) {
  let report;
  try {
    report = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    inputError("invalid_report_json");
  }
  if (findRawSensitiveKey(report)) inputError("raw_sensitive_key");
  const aggregate = report?.conversation?.rolloutEvidence?.aggregate;
  validateAggregate(aggregate);
  return aggregate;
}

function parseArgs(argv) {
  const options = { native: [], dsh: [], maxLatencyRatio: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--max-latency-ratio") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!raw || raw.startsWith("--") || !Number.isFinite(value) || value <= 0) {
        inputError("invalid_latency_threshold");
      }
      if (options.maxLatencyRatio !== null) inputError("invalid_arguments");
      options.maxLatencyRatio = value;
      index += 1;
      continue;
    }
    const runtime = argument === "--native" ? "native" : argument === "--dsh" ? "dsh" : null;
    if (!runtime) inputError("invalid_arguments");
    const filePath = argv[index + 1];
    if (!filePath || filePath.startsWith("--")) inputError("invalid_arguments");
    options[runtime].push(filePath);
    index += 1;
  }
  if (options.native.length === 0 || options.dsh.length === 0) {
    inputError("missing_runtime_report");
  }
  if (options.maxLatencyRatio === null) inputError("missing_latency_threshold");
  const allPaths = [...options.native, ...options.dsh];
  if (new Set(allPaths).size !== allPaths.length) inputError("distinct_runtime_reports_required");
  return options;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function countOutcomes(runtime) {
  return sum(Object.values(runtime.memory.outcomes));
}

function hasOnlyOutcomes(runtime, allowed) {
  return Object.keys(runtime.memory.outcomes).every((outcome) => allowed.has(outcome));
}

function allZeroCounts(value) {
  return Object.values(value).every((count) => count === 0);
}

function selectedRuntime(aggregate, runtime) {
  const evidence = aggregate.runtimes[runtime];
  if (
    evidence.attempts < MIN_ATTEMPTS_PER_RUNTIME ||
    evidence.firstTokenMs.samples !== evidence.attempts ||
    evidence.totalMs.samples !== evidence.attempts ||
    evidence.steps.samples !== evidence.attempts ||
    evidence.toolCalls.samples !== evidence.attempts ||
    evidence.retryCount.samples !== evidence.attempts ||
    evidence.usage.promptTokens.samples !== evidence.attempts ||
    evidence.usage.completionTokens.samples !== evidence.attempts
  ) {
    inputError("insufficient_samples");
  }
  return evidence;
}

function runtimeSpecificEvidence(aggregate, runtime) {
  const otherRuntime = runtime === "native" ? "dsh" : "native";
  if (
    aggregate.comparisonStatus !== "sample_insufficient" ||
    aggregate.runtimes[otherRuntime].attempts !== 0
  ) {
    inputError("runtime_report_mismatch");
  }
  return selectedRuntime(aggregate, runtime);
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function latencyComparison(nativeRuntimes, dshRuntimes, metricName, percentile, maxRatio) {
  // Aggregate percentiles cannot be recomposed. Comparing the best native
  // window with the worst DSH window is deterministic and fail-closed.
  const nativeValue = Math.min(...nativeRuntimes.map((runtime) => runtime[metricName][percentile]));
  const dshValue = Math.max(...dshRuntimes.map((runtime) => runtime[metricName][percentile]));
  const ratio = nativeValue === 0
    ? dshValue === 0 ? 1 : null
    : round(dshValue / nativeValue);
  return {
    nativeMs: nativeValue,
    dshMs: dshValue,
    ratio,
    withinThreshold: ratio !== null && ratio <= maxRatio,
  };
}

function providerIdentity(runtimes) {
  const identities = new Set();
  let complete = true;
  for (const runtime of runtimes) {
    const total = sum(runtime.providerModels.map((item) => item.count));
    if (runtime.providerModels.length !== 1 || total !== runtime.attempts) complete = false;
    for (const item of runtime.providerModels) identities.add(`${item.provider}\0${item.model}`);
  }
  const [identity] = identities;
  const [provider, model] = identity?.split("\0") ?? [];
  return {
    complete,
    unique: identities.size === 1,
    provider,
    model,
  };
}

function check(id, ok) {
  return { id, ok };
}

export function evaluateGateR({ nativeAggregates, dshAggregates, maxLatencyRatio }) {
  if (!Number.isFinite(maxLatencyRatio) || maxLatencyRatio <= 0) {
    inputError("invalid_latency_threshold");
  }
  const nativeRuntimes = nativeAggregates.map((aggregate) => runtimeSpecificEvidence(aggregate, "native"));
  const dshRuntimes = dshAggregates.map((aggregate) => runtimeSpecificEvidence(aggregate, "dsh"));
  const allRuntimes = [...nativeRuntimes, ...dshRuntimes];
  const firstTokenP50 = latencyComparison(nativeRuntimes, dshRuntimes, "firstTokenMs", "p50", maxLatencyRatio);
  const firstTokenP95 = latencyComparison(nativeRuntimes, dshRuntimes, "firstTokenMs", "p95", maxLatencyRatio);
  const totalP50 = latencyComparison(nativeRuntimes, dshRuntimes, "totalMs", "p50", maxLatencyRatio);
  const totalP95 = latencyComparison(nativeRuntimes, dshRuntimes, "totalMs", "p95", maxLatencyRatio);
  const identity = providerIdentity(allRuntimes);

  const checks = [
    check("error_rate_zero", allRuntimes.every((runtime) => runtime.rates.error === 0 && allZeroCounts(runtime.errors.byCategory) && allZeroCounts(runtime.errors.byCode))),
    check("truncated_rate_zero", allRuntimes.every((runtime) => runtime.rates.truncated === 0)),
    check("cancelled_rate_zero", allRuntimes.every((runtime) => runtime.rates.cancelled === 0 && runtime.terminal.cancelled === 0)),
    check("terminal_failures_zero", allRuntimes.every((runtime) => runtime.terminal.sent === runtime.attempts && runtime.terminal.blocked === 0 && runtime.terminal.failed === 0)),
    check("cas_conflicts_zero", allRuntimes.every((runtime) => runtime.casConflicts === 0)),
    check("sse_incomplete_zero", allRuntimes.every((runtime) => runtime.sseIncomplete === 0)),
    check("outbox_pending_zero", allRuntimes.every((runtime) => runtime.outbox.pending === 0 && runtime.outbox.oldestPendingMs === null)),
    check("outbox_failed_zero", allRuntimes.every((runtime) => runtime.outbox.failed === 0)),
    check("outbox_delivery_complete", allRuntimes.every((runtime) => runtime.outbox.events === runtime.attempts && runtime.outbox.delivered === runtime.attempts)),
    check("igrep_observed", dshRuntimes.every((runtime) => runtime.igrep.status === "observed")),
    check("igrep_failure_zero", dshRuntimes.every((runtime) => runtime.igrep.search.failure === 0 && runtime.igrep.memory.failure === 0)),
    check("memory_outcomes_settled", nativeRuntimes.every((runtime) => countOutcomes(runtime) === runtime.attempts && hasOnlyOutcomes(runtime, new Set(["extracted", "unknown"]))) && dshRuntimes.every((runtime) => countOutcomes(runtime) === runtime.attempts && hasOnlyOutcomes(runtime, new Set(["ingested", "ingested_rebuilt", "disabled"])))),
    check("sidecar_identity_stable", dshRuntimes.every((runtime) => runtime.sidecar.status === "observed" && runtime.sidecar.sampledAttempts === runtime.attempts && runtime.sidecar.distinctInstances === 1 && runtime.sidecar.instanceTransitions === 0 && runtime.sidecar.restartRatePerHour === 0)),
    check("provider_model_identity_match", identity.complete && identity.unique),
    check("firstTokenMs_p50_ratio", firstTokenP50.withinThreshold),
    check("firstTokenMs_p95_ratio", firstTokenP95.withinThreshold),
    check("totalMs_p50_ratio", totalP50.withinThreshold),
    check("totalMs_p95_ratio", totalP95.withinThreshold),
  ];
  const localBlockers = checks.filter((item) => !item.ok).map((item) => item.id);
  const publicReasons = ["internal_audit_only", "provider_cost_insufficient"];

  return {
    schemaVersion: 1,
    gate: "R",
    ok: localBlockers.length === 0,
    effectMode: "none",
    databaseUsed: false,
    decision: {
      localControlledReady: localBlockers.length === 0,
      localReason: localBlockers.length === 0
        ? "all_local_controlled_thresholds_met"
        : "local_controlled_thresholds_failed",
      publicProductionReady: false,
      publicReasons,
    },
    policy: {
      evidenceScope: "internal-audit",
      minimumAttemptsPerRuntime: MIN_ATTEMPTS_PER_RUNTIME,
      latency: {
        maxDshToNativeRatio: maxLatencyRatio,
        thresholdAuthority: "operator_supplied_from_observed_baseline_and_canary",
        crossReportComparison: "best_native_window_vs_worst_dsh_window",
        percentiles: ["firstTokenMs.p50", "firstTokenMs.p95", "totalMs.p50", "totalMs.p95"],
      },
      operationalTolerance: "zero",
      providerModel: "single_exact_identity_across_all_samples",
      providerCost: "required_for_public_production_only",
    },
    evidence: {
      reports: { native: nativeAggregates.length, dsh: dshAggregates.length },
      attempts: {
        native: sum(nativeRuntimes.map((runtime) => runtime.attempts)),
        dsh: sum(dshRuntimes.map((runtime) => runtime.attempts)),
      },
      providerModel: identity.complete && identity.unique
        ? { same: true, provider: identity.provider, model: identity.model }
        : { same: false },
      latency: {
        firstTokenMs: { p50: firstTokenP50, p95: firstTokenP95 },
        totalMs: { p50: totalP50, p95: totalP95 },
      },
      providerCost: {
        status: "insufficient",
      },
    },
    checks,
    localBlockers,
  };
}

function errorReport(code) {
  return {
    schemaVersion: 1,
    gate: "R",
    ok: false,
    effectMode: "none",
    databaseUsed: false,
    error: { code },
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = evaluateGateR({
      nativeAggregates: options.native.map(readAggregate),
      dshAggregates: options.dsh.map(readAggregate),
      maxLatencyRatio: options.maxLatencyRatio,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof GateRInputError ? error.code : "unexpected_error";
    process.stdout.write(`${JSON.stringify(errorReport(code), null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
