#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PI_VERSION = "1.3.0";
export const IGREP_VERSION = "0.1.161";
export const PI_PACKAGES = Object.freeze([
  "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord",
]);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function parseCliArgs(argv) {
  const options = { check: false, json: false };
  const seen = new Set();
  for (const argument of argv) {
    if (!["--check", "--json"].includes(argument) || seen.has(argument)) throw new Error(`invalid argument: ${argument}`);
    seen.add(argument);
    options[argument.slice(2)] = true;
  }
  return options;
}

export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.\d+$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return (major === 22 && minor >= 19) || major >= 24;
}

/**
 * Pi is installed by the workspace lockfile and igrep is a neutral CLI. There
 * are no mutable user-home profiles or copied integration modules to install.
 * Both setup and check qualify the same installed public surface; full Chat
 * readiness owns the model, compaction, retrieval and lifecycle proofs.
 */
export function runPiCompanionBootstrap(options, injected = {}) {
  const root = injected.root ?? ROOT;
  const ambient = injected.env ?? process.env;
  const execute = injected.execute ?? spawnSync;
  const readManifest = injected.readManifest ?? (name => JSON.parse(readFileSync(path.join(root, "packages/chat/node_modules", name, "package.json"), "utf8")));
  if (!isSupportedNodeVersion(injected.nodeVersion ?? process.version)) throw new Error("Node ^22.19.0 or >=24 is required");
  const packages = Object.fromEntries(PI_PACKAGES.map(name => {
    const manifest = readManifest(name);
    if (manifest.name !== name || manifest.version !== PI_VERSION) throw new Error(`Pi package version mismatch: ${name}`);
    return [name, manifest.version];
  }));
  const command = ambient.PI_IGREP_COMMAND?.trim() || "igrep";
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap(name => ambient[name] === undefined ? [] : [[name, ambient[name]]]));
  const run = (executable, args) => {
    const result = execute(executable, args, { cwd: path.join(root, "packages/chat"), env, encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576 });
    if (result.error || result.status !== 0 || result.signal) throw new Error(`runtime qualification command failed: ${executable} ${args[0]}`);
    return String(result.stdout ?? "");
  };
  const version = /\b(\d+\.\d+\.\d+)\b/u.exec(run(command, ["--version"]))?.[1];
  if (version !== IGREP_VERSION) throw new Error(`igrep version mismatch; expected ${IGREP_VERSION}`);
  const searchHelp = run(command, ["search", "--help"]);
  if (!searchHelp.includes("--stdin-format") || !searchHelp.includes("jsonl")) throw new Error("igrep public JSONL search is unavailable");
  const memoryHelp = run(command, ["mem", "--help"]);
  for (const operation of ["ingest", "maintain", "recall", "wake", "doctor", "reproject"]) {
    if (!memoryHelp.includes(operation)) throw new Error(`igrep memory ${operation} is unavailable`);
  }
  const memoryApiHelp = run(command, ["mem-api", "--help"]);
  for (const operation of ["memory-search", "memory-status"]) {
    if (!memoryApiHelp.includes(operation)) throw new Error(`igrep ${operation} JSON API is unavailable`);
  }
  const api = run("bun", ["--eval", `
    import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
    import { createModels } from '@earendil-works/pi-ai';
    import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
    const harness = await Harness.open(new MemoryStorage(), {models:createModels(),registry:createRegistry()}, context);
    try { const conversation=await harness.root(context); const entries=await conversation.entries({order:'ascending'},100,undefined,context); const view=await conversation.context(context); if(!Array.isArray(entries.items)||view.entries.length!==view.contributions.length)throw new Error('public API mismatch'); process.stdout.write('pi-public-memory-api:ok'); } finally { await harness.close(context); }
  `]);
  if (api !== "pi-public-memory-api:ok") throw new Error("Pi public MemoryStorage API qualification failed");
  return { schemaVersion: 3, ok: true, mode: options.check ? "check" : "setup", pins: { pi: PI_VERSION, igrep: version }, packages,
    igrepCommand: command, kernel: { storage: "memory", publicApi: true }, proof: "installed-public-surface", fullReadinessRequired: true };
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
    const report = runPiCompanionBootstrap(options);
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `Pi ${report.pins.pi} and igrep ${report.pins.igrep} public runtime surface verified. Full Chat readiness is still required.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime qualification failed";
    process.stderr.write(options?.json ? `${JSON.stringify({ ok: false, error: message })}\n` : `${message}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
