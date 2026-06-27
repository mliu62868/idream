#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const voiceUrl = trimTrailingSlash(
  process.env.PIPELINE_VOICE_API_URL ??
    process.env.MOSS_TTS_API_URL ??
    "http://127.0.0.1:8000/v1",
);
const voiceToken =
  process.env.PIPELINE_VOICE_API_TOKEN ??
  process.env.MOSS_TTS_API_TOKEN ??
  process.env.PIPELINE_API_TOKEN ??
  "";
const voiceModel =
  process.env.PIPELINE_VOICE_MODEL_DEFAULT ??
  process.env.MOSS_TTS_MODEL ??
  "OpenMOSS/MOSS-TTS-Local-Transformer-v1.5";
const report = process.env.VOICE_MODEL_PROBE_REPORT ?? ".tmp/launch-voice-probe.json";
const text =
  process.env.VOICE_MODEL_PROBE_TEXT ??
  "Internal beta voice probe. MOSS TTS should return a short audio sample.";
const voice = process.env.VOICE_MODEL_PROBE_VOICE_ID ?? defaultVoiceForModel(voiceModel);

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
  env: {
    ...process.env,
    VOICE_PROVIDER: "pipeline",
    PIPELINE_VOICE_API_URL: voiceUrl,
    PIPELINE_VOICE_API_TOKEN: voiceToken,
    PIPELINE_API_TOKEN: voiceToken,
    PIPELINE_VOICE_MODEL_DEFAULT: voiceModel,
  },
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

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function defaultVoiceForModel(model) {
  return model.toLowerCase().includes("qwen3-tts") ? "serena" : "default";
}
