#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const tmpDir = path.join(repoRoot, ".tmp");

const args = process.argv.slice(2);
const includeVoice = hasFlag("include-voice");
const includeCatalog = hasFlag("include-catalog");
const reportPath = valueArg("report") ?? ".tmp/internal-pipeline-probes.json";

mkdirSync(tmpDir, { recursive: true });

const mainEnv = readEnvFile("packages/main/.env");
const chatEnv = readEnvFile("packages/chat/.env");
const genEnv = readEnvFile("packages/gen/.env");

const baseEnv = {
  ...mainEnv,
  ...process.env,
};

const mainWebUrl =
  process.env.MAIN_WEB_URL ??
  mainEnv.MAIN_WEB_URL ??
  mainEnv.BETTER_AUTH_URL ??
  "http://127.0.0.1:3000";
const adminWebUrl =
  process.env.ADMIN_WEB_URL ?? mainEnv.ADMIN_WEB_URL ?? "http://127.0.0.1:3001";
const chatServiceUrl =
  process.env.CHAT_SERVICE_URL ?? mainEnv.CHAT_SERVICE_URL ?? "http://127.0.0.1:3100";
const chatServiceProbeUserId =
  process.env.CHAT_SERVICE_PROBE_USER_ID ??
  mainEnv.CHAT_SERVICE_PROBE_USER_ID ??
  "seed-chat-probe-user";
const chatBffSigningSecret =
  process.env.CHAT_BFF_SIGNING_SECRET ??
  mainEnv.CHAT_BFF_SIGNING_SECRET ??
  chatEnv.CHAT_BFF_SIGNING_SECRET ??
  "";
const imageModel = process.env.PIPELINE_IMAGE_MODEL_DEFAULT ?? genEnv.PIPELINE_IMAGE_MODEL_DEFAULT ?? "redcraft-qw21t";
const voiceProvider = baseEnv.VOICE_PROVIDER ?? "mock";
const voiceApiUrl = voiceProvider === "pocket-tts" ? baseEnv.POCKET_TTS_API_URL
  : voiceProvider === "fish-audio" ? baseEnv.FISH_AUDIO_API_URL : undefined;
const voiceModel = voiceProvider === "pocket-tts" ? baseEnv.POCKET_TTS_MODEL ?? "pocket-tts"
  : voiceProvider === "fish-audio" ? baseEnv.FISH_AUDIO_MODEL ?? "ming-3.0-tts-0.5b-8bit" : "mock-voice-probe";
const voiceProbeVoiceId = baseEnv.VOICE_MODEL_PROBE_VOICE_ID ?? (voiceProvider === "pocket-tts"
  ? baseEnv.POCKET_TTS_DEFAULT_VOICE_ID ?? "anna" : baseEnv.FISH_AUDIO_DEFAULT_VOICE_ID ?? "fish-female-default");

const steps = [
  {
    id: "web-surface",
    required: true,
    command: "bun",
    args: [
      "run",
      "launch:probe:web-surface",
      "--",
      "--report",
      ".tmp/launch-web-surface-probe.json",
    ],
    env: {
      ...baseEnv,
      MAIN_WEB_URL: mainWebUrl,
      ADMIN_WEB_URL: adminWebUrl,
    },
  },
  {
    id: "product-config",
    required: true,
    command: "bun",
    args: [
      "run",
      "launch:probe:product-config",
      "--",
      "--report",
      ".tmp/launch-product-config-probe.json",
    ],
    env: baseEnv,
  },
  {
    id: "chat-service",
    required: true,
    command: "bun",
    args: [
      "run",
      "launch:probe:chat-service",
      "--",
      "--report",
      ".tmp/launch-chat-service-probe.json",
    ],
    env: {
      ...baseEnv,
      CHAT_SERVICE_URL: chatServiceUrl,
      CHAT_BFF_SIGNING_SECRET: chatBffSigningSecret,
      CHAT_SERVICE_PROBE_USER_ID: chatServiceProbeUserId,
    },
  },
];

if (includeVoice || voiceProvider === "pocket-tts" || voiceProvider === "fish-audio") {
  steps.push({
    id: "voice-model",
    required: includeVoice,
    command: "bun",
    args: [
      "run",
      "launch:probe:voice",
      "--",
      "--report",
      ".tmp/launch-voice-probe.json",
    ],
    env: {
      ...baseEnv,
      VOICE_PROVIDER: voiceProvider,
      VOICE_MODEL_PROBE_VOICE_ID: voiceProbeVoiceId,
    },
  });
} else {
  steps.push({
    id: "voice-model",
    required: false,
    skipped: true,
    reason: "No real voice provider is configured; pass --include-voice to require voice synthesis.",
  });
}

if (includeCatalog) {
  steps.push({
    id: "public-catalog",
    required: true,
    command: "bun",
    args: [
      "run",
      "launch:probe:catalog",
      "--",
      "--report",
      ".tmp/public-catalog-probe.json",
      "--max-issues=5",
    ],
    env: baseEnv,
  });
}

const results = [];
for (const step of steps) {
  if (step.skipped) {
    console.log(`\n[skip] ${step.id}: ${step.reason}`);
    results.push({
      id: step.id,
      required: step.required,
      skipped: true,
      ok: true,
      reason: step.reason,
    });
    continue;
  }

  console.log(`\n[run] ${step.id}`);
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...step.env,
    },
    stdio: "inherit",
  });
  const ok = result.status === 0;
  results.push({
    id: step.id,
    required: step.required,
    skipped: false,
    ok,
    exitCode: result.status ?? 1,
  });
}

const requiredFailures = results.filter((result) => result.required && !result.ok);
const report = {
  ok: requiredFailures.length === 0,
  checkedAt: new Date().toISOString(),
  mode: "internal-pipeline-beta",
  inputs: {
    mainWebUrl,
    adminWebUrl,
    chatServiceUrl,
    chatServiceProbeUserId,
    imageModel,
    voiceProvider,
    voiceApiUrl: voiceApiUrl ?? null,
    voiceModel,
    voiceProbeVoiceId,
    includeVoice,
    includeCatalog,
  },
  results,
};

const absoluteReportPath = path.isAbsolute(reportPath)
  ? reportPath
  : path.join(repoRoot, reportPath);
mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n[summary] ${report.ok ? "PASS" : "FAIL"} ${results.filter((r) => r.ok).length}/${results.length}`);
console.log(`[report] ${path.relative(repoRoot, absoluteReportPath)}`);

if (!report.ok) process.exitCode = 1;

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function valueArg(name) {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function readEnvFile(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  if (!existsSync(filePath)) return {};
  const output = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    const value = stripQuotes(normalized.slice(equals + 1).trim());
    output[key] = value;
  }
  return output;
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
