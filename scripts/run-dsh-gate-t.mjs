#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTPUT_LIMIT = 4_000;

export const GATE_T_CHECKS = Object.freeze([
  Object.freeze({
    id: "sidecar-tool-loop",
    cwd: "packages/chat-agent",
    command: "bun",
    args: Object.freeze([
      "run",
      "test",
      "--",
      "src/engine.test.ts",
      "-t",
      "\\[Gate T\\]",
    ]),
    scenarios: Object.freeze([
      "multi_step_single_tool",
      "tool_error",
      "tool_timeout",
    ]),
  }),
  Object.freeze({
    id: "chat-tool-recovery",
    cwd: "packages/chat",
    command: "bun",
    args: Object.freeze([
      "run",
      "test:pure",
      "--",
      "src/generate-agent-tools.test.ts",
      "-t",
      "\\[Gate T\\]",
    ]),
    scenarios: Object.freeze([
      "attempt_call_replay",
      "reservation_authority_loss",
      "crash_before_intent",
      "crash_after_result",
      "single_artifact",
      "single_delivery",
      "terminal_replay_noop",
    ]),
  }),
]);

export function parseGateTArgs(argv) {
  let report = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--report") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--report requires a path");
    }
    report = value;
    index += 1;
  }
  return { report };
}

function tail(value) {
  const text = typeof value === "string" ? value : "";
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

export function runGateTProbe({
  root = REPO_ROOT,
  execute = spawnSync,
  now = () => new Date(),
} = {}) {
  const checkedAt = now().toISOString();
  const startedAt = Date.now();
  const checks = GATE_T_CHECKS.map((check) => {
    const checkStartedAt = Date.now();
    const result = execute(check.command, [...check.args], {
      cwd: path.join(root, check.cwd),
      encoding: "utf8",
      env: process.env,
    });
    const exitCode = typeof result.status === "number" ? result.status : null;
    return {
      id: check.id,
      ok: exitCode === 0,
      scenarios: [...check.scenarios],
      command: [check.command, ...check.args],
      exitCode,
      signal: result.signal ?? null,
      durationMs: Math.max(0, Date.now() - checkStartedAt),
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
  });
  return {
    schemaVersion: 1,
    checkedAt,
    ok: checks.every((check) => check.ok),
    durationMs: Math.max(0, Date.now() - startedAt),
    effectMode: "none",
    databaseUsed: false,
    checks,
  };
}

function main() {
  const options = parseGateTArgs(process.argv.slice(2));
  const report = runGateTProbe();
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.report) {
    const reportPath = path.resolve(REPO_ROOT, options.report);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, output, "utf8");
  }
  process.stdout.write(output);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
