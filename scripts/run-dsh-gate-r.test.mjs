import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./run-dsh-gate-r.mjs", import.meta.url));

function metric(samples, p50, p95) {
  return { samples, p50, p95 };
}

function emptyRuntime(runtime) {
  return {
    attempts: 0,
    terminal: { sent: 0, blocked: 0, failed: 0, cancelled: 0 },
    rates: { error: null, truncated: null, cancelled: null },
    firstTokenMs: metric(0, null, null),
    totalMs: metric(0, null, null),
    steps: metric(0, null, null),
    toolCalls: metric(0, null, null),
    retryCount: metric(0, null, null),
    usage: {
      promptTokens: metric(0, null, null),
      completionTokens: metric(0, null, null),
      reasoningTokens: metric(0, null, null),
    },
    providerModels: [],
    providerCost: {
      status: "insufficient",
      samples: 0,
      totalMicros: null,
      reason: "provider_cost_not_reported_by_companion_upstream",
    },
    errors: { byCategory: {}, byCode: {} },
    memory: { outcomes: {}, settleLagMs: metric(0, null, null) },
    sidecar: runtime === "native"
      ? {
          status: "not_applicable",
          sampledAttempts: 0,
          distinctInstances: 0,
          instanceTransitions: 0,
          restartRatePerHour: null,
        }
      : {
          status: "insufficient",
          sampledAttempts: 0,
          distinctInstances: 0,
          instanceTransitions: 0,
          restartRatePerHour: null,
          reason: "complete_instance_identity_requires_at_least_two_dsh_attempts",
        },
    igrep: runtime === "native"
      ? {
          status: "not_applicable",
          search: {
            calls: 0, hit: 0, empty: 0, failure: 0, resultCount: 0,
            latencyMs: metric(0, null, null),
          },
          memory: {
            calls: 0, hit: 0, empty: 0, failure: 0, resultCount: 0,
            latencyMs: metric(0, null, null),
          },
        }
      : {
          status: "insufficient",
          search: {
            calls: 0, hit: 0, empty: 0, failure: 0, resultCount: 0,
            latencyMs: metric(0, null, null),
          },
          memory: {
            calls: 0, hit: 0, empty: 0, failure: 0, resultCount: 0,
            latencyMs: metric(0, null, null),
          },
          reason: "igrep_observation_coverage_incomplete",
        },
    casConflicts: 0,
    sseIncomplete: 0,
    outbox: {
      events: 0,
      delivered: 0,
      pending: 0,
      failed: 0,
      deliveryLagMs: metric(0, null, null),
      oldestPendingMs: null,
    },
  };
}

function observedRuntime(runtime) {
  const value = emptyRuntime(runtime);
  value.attempts = 4;
  value.terminal.sent = 4;
  value.rates = { error: 0, truncated: 0, cancelled: 0 };
  value.firstTokenMs = runtime === "native"
    ? metric(4, 100, 180)
    : metric(4, 180, 340);
  value.totalMs = runtime === "native"
    ? metric(4, 1_000, 1_800)
    : metric(4, 1_800, 3_400);
  value.steps = metric(4, 1, 1);
  value.toolCalls = metric(4, 0, 0);
  value.retryCount = metric(4, 0, 0);
  value.usage.promptTokens = metric(4, 1_000, 1_200);
  value.usage.completionTokens = metric(4, 180, 220);
  value.providerModels = [{ provider: "openai", model: "pinned-local-model", count: 4 }];
  value.memory.outcomes = runtime === "native"
    ? { extracted: 2, unknown: 2 }
    : { ingested: 3, disabled: 1 };
  if (runtime === "dsh") {
    value.memory.settleLagMs = metric(4, 25, 40);
    value.sidecar = {
      status: "observed",
      sampledAttempts: 4,
      distinctInstances: 1,
      instanceTransitions: 0,
      restartRatePerHour: 0,
    };
    value.igrep = {
      status: "observed",
      search: {
        calls: 3, hit: 2, empty: 1, failure: 0, resultCount: 2,
        latencyMs: metric(3, 12, 18),
      },
      memory: {
        calls: 3, hit: 0, empty: 3, failure: 0, resultCount: 0,
        latencyMs: metric(3, 20, 28),
      },
    };
  }
  value.outbox = {
    events: 4,
    delivered: 4,
    pending: 0,
    failed: 0,
    deliveryLagMs: metric(4, 50, 80),
    oldestPendingMs: null,
  };
  return value;
}

function report(runtime) {
  const from = runtime === "native"
    ? "2026-08-20T10:00:00.000Z"
    : "2026-08-20T11:00:00.000Z";
  const to = runtime === "native"
    ? "2026-08-20T10:05:00.000Z"
    : "2026-08-20T11:05:00.000Z";
  return {
    ok: true,
    userId: "signed-probe-actor-is-not-decision-input",
    conversation: {
      rolloutEvidence: {
        ok: true,
        aggregate: {
          schemaVersion: 1,
          generatedAt: to,
          window: { from, to, durationMs: 300_000 },
          comparisonStatus: "sample_insufficient",
          sampleEvidence: runtime === "native"
            ? { native: "observed", dsh: "no_samples" }
            : { native: "no_samples", dsh: "observed" },
          releaseDecision: {
            status: "not_evaluated",
            reason: "no_gate_thresholds_or_observation_window_policy",
          },
          runtimes: {
            native: runtime === "native" ? observedRuntime("native") : emptyRuntime("native"),
            dsh: runtime === "dsh" ? observedRuntime("dsh") : emptyRuntime("dsh"),
          },
          dataScope: {
            userAuthority: "core.chat_user_view",
            scope: "internal-audit",
            includedDataClass: "audit",
            activeCustomersOnly: false,
            exactAuditActorOnly: true,
            userFilterApplied: true,
            windowBasis: "message_versions.created_at",
          },
        },
      },
    },
  };
}

function runGate({
  native = report("native"),
  dsh = report("dsh"),
  args = ["--max-latency-ratio", "2"],
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "idream-gate-r-test-"));
  const nativePath = path.join(directory, "native.json");
  const dshPath = path.join(directory, "dsh.json");
  writeFileSync(nativePath, JSON.stringify(native));
  writeFileSync(dshPath, JSON.stringify(dsh));
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--native", nativePath,
    "--dsh", dshPath,
    ...args,
  ], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

test("Gate R admits healthy internal-audit evidence only for local controlled use", () => {
  const result = runGate();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.decision, {
    localControlledReady: true,
    localReason: "all_local_controlled_thresholds_met",
    publicProductionReady: false,
    publicReasons: ["internal_audit_only", "provider_cost_insufficient"],
  });
  assert.deepEqual(result.json.evidence.attempts, { native: 4, dsh: 4 });
  assert.deepEqual(result.json.evidence.providerModel, {
    same: true,
    provider: "openai",
    model: "pinned-local-model",
  });
  assert.equal(result.json.policy.latency.maxDshToNativeRatio, 2);
  assert.equal(result.json.evidence.latency.firstTokenMs.p95.ratio, 1.888889);
  assert.equal(result.stdout.includes("signed-probe-actor"), false);
  assert.equal(result.stdout.includes("native.json"), false);
});

test("Gate R fails valid evidence when any zero-tolerance operational invariant is violated", () => {
  const cases = [
    ["error_rate_zero", (value) => { value.rates.error = 0.25; }],
    ["truncated_rate_zero", (value) => { value.rates.truncated = 0.25; }],
    ["cancelled_rate_zero", (value) => { value.rates.cancelled = 0.25; }],
    ["terminal_failures_zero", (value) => { value.terminal.failed = 1; value.terminal.sent = 3; }],
    ["cas_conflicts_zero", (value) => { value.casConflicts = 1; }],
    ["sse_incomplete_zero", (value) => { value.sseIncomplete = 1; }],
    ["outbox_pending_zero", (value) => { value.outbox.pending = 1; value.outbox.delivered = 3; }],
    ["outbox_failed_zero", (value) => { value.outbox.failed = 1; value.outbox.delivered = 3; }],
    ["igrep_failure_zero", (value) => { value.igrep.memory.failure = 1; value.igrep.memory.empty = 2; }],
    ["memory_outcomes_settled", (value) => { value.memory.outcomes = { ingested: 2, disabled: 1, failed: 1 }; }],
    ["sidecar_identity_stable", (value) => { value.sidecar.distinctInstances = 2; value.sidecar.instanceTransitions = 1; }],
  ];

  for (const [expectedBlocker, mutate] of cases) {
    const dsh = report("dsh");
    mutate(dsh.conversation.rolloutEvidence.aggregate.runtimes.dsh);
    const result = runGate({ dsh });
    assert.equal(result.status, 1, `${expectedBlocker}: ${result.stderr}`);
    assert.equal(result.json.decision.localControlledReady, false);
    assert.ok(
      result.json.localBlockers.includes(expectedBlocker),
      `${expectedBlocker}: ${JSON.stringify(result.json.localBlockers)}`,
    );
  }
});

test("Gate R compares all first-token and total latency percentiles against an explicit ratio", () => {
  for (const [metricName, percentile] of [
    ["firstTokenMs", "p50"],
    ["firstTokenMs", "p95"],
    ["totalMs", "p50"],
    ["totalMs", "p95"],
  ]) {
    const dsh = report("dsh");
    const native = report("native");
    const baseline = native.conversation.rolloutEvidence.aggregate.runtimes.native[metricName][percentile];
    dsh.conversation.rolloutEvidence.aggregate.runtimes.dsh[metricName][percentile] = baseline * 2 + 1;
    const result = runGate({ native, dsh });
    assert.equal(result.status, 1, `${metricName}.${percentile}: ${result.stderr}`);
    assert.ok(result.json.localBlockers.includes(`${metricName}_${percentile}_ratio`));
  }
});

test("Gate R rejects provider/model drift before latency can be attributed", () => {
  const dsh = report("dsh");
  dsh.conversation.rolloutEvidence.aggregate.runtimes.dsh.providerModels[0].model = "other-model";
  const result = runGate({ dsh });

  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.json.localBlockers.includes("provider_model_identity_match"));
});

test("Gate R distinguishes zero igrep calls from missing coverage and actual failures", () => {
  const zeroCalls = report("dsh");
  for (const operation of ["search", "memory"]) {
    zeroCalls.conversation.rolloutEvidence.aggregate.runtimes.dsh.igrep[operation] = {
      calls: 0,
      hit: 0,
      empty: 0,
      failure: 0,
      resultCount: 0,
      latencyMs: metric(0, null, null),
    };
  }
  const accepted = runGate({ dsh: zeroCalls });
  assert.equal(accepted.status, 0, accepted.stderr);

  const uncovered = report("dsh");
  uncovered.conversation.rolloutEvidence.aggregate.runtimes.dsh.igrep.status = "insufficient";
  uncovered.conversation.rolloutEvidence.aggregate.runtimes.dsh.igrep.reason =
    "igrep_observation_coverage_incomplete";
  const rejected = runGate({ dsh: uncovered });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.ok(rejected.json.localBlockers.includes("igrep_observed"));
  assert.equal(rejected.json.localBlockers.includes("igrep_failure_zero"), false);
});

test("Gate R exits 2 for insufficient samples, schema drift, invalid audit scope, or raw sensitive keys", () => {
  const cases = [
    ["insufficient_samples", (value) => {
      const runtime = value.conversation.rolloutEvidence.aggregate.runtimes.dsh;
      runtime.attempts = 1;
    }],
    ["schema_drift", (value) => {
      value.conversation.rolloutEvidence.aggregate.schemaVersion = 2;
    }],
    ["invalid_evidence_scope", (value) => {
      value.conversation.rolloutEvidence.aggregate.dataScope.scope = "customers";
    }],
    ["raw_sensitive_key", (value) => {
      value.prompt = "must never reach Gate R";
    }],
  ];

  for (const [expectedCode, mutate] of cases) {
    const dsh = report("dsh");
    mutate(dsh);
    const result = runGate({ dsh });
    assert.equal(result.status, 2, `${expectedCode}: ${result.stderr}`);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, expectedCode);
    assert.equal(result.stdout.includes("must never reach"), false);
  }
});

test("Gate R rejects mixed runtime windows and requires an operator-supplied latency threshold", () => {
  const mixed = report("dsh");
  const aggregate = mixed.conversation.rolloutEvidence.aggregate;
  aggregate.runtimes.native = observedRuntime("native");
  aggregate.sampleEvidence.native = "observed";
  aggregate.comparisonStatus = "observed";
  const mismatched = runGate({ dsh: mixed });
  assert.equal(mismatched.status, 2, mismatched.stderr);
  assert.equal(mismatched.json.error.code, "runtime_report_mismatch");

  const missingThreshold = runGate({ args: [] });
  assert.equal(missingThreshold.status, 2, missingThreshold.stderr);
  assert.equal(missingThreshold.json.error.code, "missing_latency_threshold");
});

test("Gate R requires one explicit native report and one explicit DSH report", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "idream-gate-r-args-"));
  const nativePath = path.join(directory, "native.json");
  writeFileSync(nativePath, JSON.stringify(report("native")));
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--native", nativePath,
    "--max-latency-ratio", "2",
  ], {
    encoding: "utf8",
  });
  rmSync(directory, { recursive: true, force: true });

  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "missing_runtime_report");
});
