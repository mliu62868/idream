import assert from "node:assert/strict";
import test from "node:test";
import {
  PI_GATE_CHECKS,
  parsePiGateArgs,
  runPiGateProbe,
} from "./run-pi-gate.mjs";

test("Pi gate runner is bounded to embedded runtime and Chat public-seam tests", () => {
  assert.deepEqual(
    PI_GATE_CHECKS.map(({ id, cwd, scenarios }) => ({ id, cwd, scenarios })),
    [
      {
        id: "embedded-runtime-tool-loop",
        cwd: "packages/chat",
        scenarios: [
          "direct_terminal_commit",
          "single_product_tool",
          "main_cas_rejection",
          "in_process_cancel",
          "native_pi_provider_and_compaction",
          "attempt_scoped_original_recall",
          "pinned_runtime_readiness",
        ],
      },
      {
        id: "chat-tool-recovery",
        cwd: "packages/chat",
        scenarios: [
          "admission_identity_and_deadline",
          "bounded_terminal_candidate",
          "recover_valid_agent_runs",
          "account_erasure_drain",
          "agent_authored_image_direction",
          "same_identity_ambiguous_ack_recovery",
        ],
      },
    ],
  );
  for (const check of PI_GATE_CHECKS) {
    assert.equal(check.command, "bun");
    assert.ok(!check.args.some((argument) => /integration|prisma|db:/u.test(argument)));
  }
});

test("Pi gate runner reports every check and fails closed on one non-zero exit", () => {
  const calls = [];
  const exits = [0, 1];
  const report = runPiGateProbe({
    root: "/repo",
    now: () => new Date("2026-08-20T12:00:00.000Z"),
    execute(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return {
        status: exits.shift() ?? 1,
        signal: null,
        stdout: "Tests 8 passed (8)",
        stderr: "fixture stderr",
      };
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.checkedAt, "2026-08-20T12:00:00.000Z");
  assert.equal(report.checks.length, 2);
  assert.deepEqual(report.checks.map((check) => check.ok), [true, false]);
  assert.deepEqual(calls.map((call) => call.cwd), [
    "/repo/packages/chat",
    "/repo/packages/chat",
  ]);
});

test("Pi gate rejects a zero exit when every selected test was skipped", () => {
  const report = runPiGateProbe({ execute() {
    return { status: 0, signal: null, stdout: "Test Files 1 skipped (1)\nTests 8 skipped (8)", stderr: "" };
  } });
  assert.equal(report.ok, false);
  assert.ok(report.checks.every((check) => check.ok === false));
});

test("Pi gate CLI accepts only an optional explicit report path", () => {
  assert.deepEqual(parsePiGateArgs([]), { report: null });
  assert.deepEqual(parsePiGateArgs(["--report", ".tmp/pi-gate.json"]), {
    report: ".tmp/pi-gate.json",
  });
  assert.throws(() => parsePiGateArgs(["--live"]), /unknown argument/u);
  assert.throws(() => parsePiGateArgs(["--report"]), /requires a path/u);
});
