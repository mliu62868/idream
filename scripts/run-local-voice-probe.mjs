#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

// Match Main's non-overriding environment load, including calls from repo root.
const envPath = path.join(repoRoot, "packages/main/.env");
const configuredEnv = {
  ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {}),
  ...process.env,
};
const provider = configuredEnv.VOICE_PROVIDER ?? "mock";
if (provider !== "pocket-tts" && provider !== "fish-audio") {
  throw new Error(`Local voice probes require VOICE_PROVIDER=pocket-tts or fish-audio; received ${provider}`);
}
const report = configuredEnv.VOICE_MODEL_PROBE_REPORT ?? ".tmp/launch-voice-probe.json";
const text = configuredEnv.VOICE_MODEL_PROBE_TEXT ??
  "Internal beta voice probe. The configured voice runtimes should return short audio samples.";
const voice = configuredEnv.VOICE_MODEL_PROBE_VOICE_ID ?? (provider === "pocket-tts"
  ? configuredEnv.POCKET_TTS_DEFAULT_VOICE_ID ?? "anna"
  : configuredEnv.FISH_AUDIO_DEFAULT_VOICE_ID ?? "fish-female-default");
mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });

const passthrough = process.argv.slice(2);
const probeArgs = [
  "run",
  "--filter",
  "@idream/main",
  "probe:voice",
  "--",
  ...defaultArg(passthrough, "report", report),
  ...defaultArg(passthrough, "text", text),
  ...defaultArg(passthrough, "voice", voice),
  ...passthrough,
];

const result = spawnSync("bun", probeArgs, {
  cwd: repoRoot,
  env: { ...configuredEnv, VOICE_PROVIDER: provider },
  stdio: "inherit",
});

process.exitCode = result.status ?? 1;

function defaultArg(args, name, value) {
  if (hasArg(args, name)) return [];
  return [`--${name}`, value];
}

function hasArg(args, name) {
  return args.some(
    (arg, index) =>
      arg === `--${name}` ||
      arg.startsWith(`--${name}=`) ||
      args[index - 1] === `--${name}`,
  );
}
