import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_T_CHECKS,
  parseGateTArgs,
  runGateTProbe,
} from "./run-dsh-gate-t.mjs";

test("Gate T runner is bounded to embedded runtime and Chat public-seam tests", () => {
  assert.deepEqual(
    GATE_T_CHECKS.map(({ id, cwd, scenarios }) => ({ id, cwd, scenarios })),
    [
      {
        id: "embedded-runtime-tool-loop",
        cwd: "packages/chat",
        scenarios: [
          "direct_terminal_commit",
          "single_product_tool",
          "main_cas_rejection",
          "in_process_cancel",
        ],
      },
      {
        id: "chat-tool-recovery",
        cwd: "packages/chat",
        scenarios: [
          "attempt_call_replay",
          "reservation_authority_loss",
          "crash_before_intent",
          "crash_after_result",
          "single_artifact",
          "single_delivery",
          "terminal_replay_noop",
        ],
      },
    ],
  );
  for (const check of GATE_T_CHECKS) {
    assert.equal(check.command, "bun");
    assert.ok(!check.args.some((argument) => /integration|prisma|db:/u.test(argument)));
  }
});

test("Gate T runner reports every check and fails closed on one non-zero exit", () => {
  const calls = [];
  const exits = [0, 1];
  const report = runGateTProbe({
    root: "/repo",
    now: () => new Date("2026-08-20T12:00:00.000Z"),
    execute(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return {
        status: exits.shift() ?? 1,
        signal: null,
        stdout: "fixture stdout",
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

test("Gate T CLI accepts only an optional explicit report path", () => {
  assert.deepEqual(parseGateTArgs([]), { report: null });
  assert.deepEqual(parseGateTArgs(["--report", ".tmp/gate-t.json"]), {
    report: ".tmp/gate-t.json",
  });
  assert.throws(() => parseGateTArgs(["--live"]), /unknown argument/u);
  assert.throws(() => parseGateTArgs(["--report"]), /requires a path/u);
});
