import assert from "node:assert/strict";
import test from "node:test";
import { IGREP_VERSION, PI_PACKAGES, PI_VERSION, isSupportedNodeVersion, parseCliArgs, runPiCompanionBootstrap } from "./setup-pi-companion.mjs";

function fixture() {
  const calls = [];
  return {
    calls, root: "/repo", nodeVersion: "v24.0.0",
    env: { PATH: "/usr/bin", HOME: "/personal", PI_IGREP_COMMAND: "/runtime/igrep", OPENAI_API_KEY: "must-not-inherit" },
    readManifest: name => ({ name, version: PI_VERSION }),
    execute(command, args, options) {
      calls.push({ command, args, options });
      const stdout = command === "bun" ? "pi-public-memory-api:ok"
        : args[0] === "--version" ? `igrep ${IGREP_VERSION}\n`
        : args[0] === "search" ? "--stdin-format {text,jsonl}"
        : args[0] === "mem-api" ? "memory-search memory-status"
        : "ingest maintain recall wake doctor reproject";
      return { status: 0, signal: null, stdout, stderr: "" };
    },
  };
}

test("bootstrap qualifies the locked public runtime without installing home profiles", () => {
  const runtime = fixture();
  const report = runPiCompanionBootstrap({ check: false, json: true }, runtime);
  assert.equal(report.ok, true);
  assert.deepEqual(report.pins, { pi: "1.3.0", igrep: "0.1.161" });
  assert.deepEqual(Object.keys(report.packages), PI_PACKAGES);
  assert.equal(report.fullReadinessRequired, true);
  assert.deepEqual(runtime.calls.map(call => call.command), ["/runtime/igrep", "/runtime/igrep", "/runtime/igrep", "/runtime/igrep", "bun"]);
  assert(runtime.calls.every(call => call.options.cwd === "/repo/packages/chat" && call.options.timeout === 30_000));
  assert(runtime.calls.every(call => call.options.env.HOME === undefined && call.options.env.OPENAI_API_KEY === undefined));
  assert(!JSON.stringify(report).includes("must-not-inherit"));
  assert.equal(runPiCompanionBootstrap({ check: true }, fixture()).mode, "check");
});

test("drift, incomplete CLI surface and failed public kernel proof cannot pass", () => {
  const manifest = fixture();
  manifest.readManifest = name => ({ name, version: "1.2.0" });
  assert.throws(() => runPiCompanionBootstrap({}, manifest), /package version mismatch/u);
  assert.equal(manifest.calls.length, 0);
  for (const [firstArg, output, error] of [
    ["--version", "igrep 0.1.150", /igrep version mismatch/u],
    ["search", "ordinary search", /JSONL search/u],
    ["mem", "ingest maintain wake doctor reproject", /memory recall/u],
    ["mem-api", "memory-status", /memory-search JSON API/u],
    ["--eval", "", /MemoryStorage API/u],
  ]) {
    const runtime = fixture(); const execute = runtime.execute;
    runtime.execute = (command, args, options) => args[0] === firstArg ? { status: 0, stdout: output } : execute(command, args, options);
    assert.throws(() => runPiCompanionBootstrap({}, runtime), error);
  }
  const failed = fixture(); failed.execute = () => ({ status: 1, stderr: "secret upstream error" });
  assert.throws(() => runPiCompanionBootstrap({}, failed), error => /command failed/u.test(error.message) && !error.message.includes("secret"));
});

test("CLI flags and Node engine contract are explicit", () => {
  assert.deepEqual(parseCliArgs(["--check", "--json"]), { check: true, json: true });
  for (const args of [["--check", "--check"], ["--home"], ["--latest"]]) assert.throws(() => parseCliArgs(args), /invalid argument/u);
  for (const version of ["22.19.0", "v22.20.0", "24.0.0", "25.0.0"]) assert(isSupportedNodeVersion(version));
  for (const version of ["22.18.0", "23.1.0", "20.0.0", "invalid"]) assert(!isSupportedNodeVersion(version));
});
