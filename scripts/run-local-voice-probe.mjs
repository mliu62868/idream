#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const provider = process.env.VOICE_PROVIDER ?? "fish-audio";
const fishAudio = provider === "fish-audio";
const pocketTts = provider === "pocket-tts";
const voiceUrl = trimTrailingSlash(
  fishAudio
    ? process.env.FISH_AUDIO_API_URL ?? "http://127.0.0.1:8062/v1"
    : pocketTts
    ? process.env.POCKET_TTS_API_URL ?? "http://127.0.0.1:8062/v1"
    : process.env.PIPELINE_VOICE_API_URL ??
      process.env.MOSS_TTS_API_URL ??
      "http://127.0.0.1:8000/v1",
);
const voiceToken = fishAudio
  ? process.env.FISH_AUDIO_API_TOKEN ?? ""
  : pocketTts
  ? process.env.POCKET_TTS_API_TOKEN ?? ""
  : process.env.PIPELINE_VOICE_API_TOKEN ??
    process.env.MOSS_TTS_API_TOKEN ??
    process.env.PIPELINE_API_TOKEN ??
    "";
const voiceModel = fishAudio
  ? process.env.FISH_AUDIO_MODEL ?? "fish-audio-s2-pro-8bit"
  : pocketTts
  ? process.env.POCKET_TTS_MODEL ?? "pocket-tts-4bit"
  : process.env.PIPELINE_VOICE_MODEL_DEFAULT ??
    process.env.MOSS_TTS_MODEL ??
    "OpenMOSS/MOSS-TTS-Local-Transformer-v1.5";
const report = process.env.VOICE_MODEL_PROBE_REPORT ?? ".tmp/launch-voice-probe.json";
const text =
  process.env.VOICE_MODEL_PROBE_TEXT ??
  "Internal beta voice probe. Fish Audio should return a short audio sample.";
const voice = process.env.VOICE_MODEL_PROBE_VOICE_ID ?? defaultVoiceForModel(voiceModel);

mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });

if (voiceModel.toLowerCase().includes("kokoro")) {
  const prepare = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "prepare-omlx-kokoro.mjs"),
      "--model",
      voiceModel,
      "--fail-if-changed",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if ((prepare.status ?? 1) !== 0) {
    process.exitCode = prepare.status ?? 1;
    process.exit();
  }
}

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
    VOICE_PROVIDER: provider,
    ...(fishAudio
      ? {
          FISH_AUDIO_API_URL: voiceUrl,
          FISH_AUDIO_API_TOKEN: voiceToken,
          FISH_AUDIO_MODEL: voiceModel,
        }
      : pocketTts
      ? {
          POCKET_TTS_API_URL: voiceUrl,
          POCKET_TTS_API_TOKEN: voiceToken,
          POCKET_TTS_MODEL: voiceModel,
        }
      : {
          PIPELINE_VOICE_API_URL: voiceUrl,
          PIPELINE_VOICE_API_TOKEN: voiceToken,
          PIPELINE_API_TOKEN: voiceToken,
          PIPELINE_VOICE_MODEL_DEFAULT: voiceModel,
        }),
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
  const normalized = model.toLowerCase();
  if (normalized.includes("qwen3-tts")) return "serena";
  if (normalized.includes("kokoro")) return "af_heart";
  if (normalized.includes("pocket-tts")) return "alba";
  if (normalized.includes("fish-audio")) return "fish-female-default";
  return "default";
}
