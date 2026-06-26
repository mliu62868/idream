#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const pipelineUrl = trimTrailingSlash(
  process.env.PIPELINE_API_URL ?? process.env.SDCPP_IMAGE_URL ?? "http://127.0.0.1:8091",
);
const pipelineToken = process.env.PIPELINE_API_TOKEN ?? "local-pipeline-token-0123456789";
const imageSize = process.env.PIPELINE_IMAGE_SIZE_DEFAULT ?? "512x512";
const blobRoot = process.env.BLOB_ROOT ?? path.join(repoRoot, ".tmp/probe-blob");
const report = process.env.PIPELINE_IMAGE_PROBE_REPORT ?? ".tmp/launch-image-probe.json";
const prompt = process.env.PIPELINE_IMAGE_PROBE_PROMPT ?? "launch readiness portrait";
const count = process.env.PIPELINE_IMAGE_PROBE_COUNT ?? "1";
const orientation = process.env.PIPELINE_IMAGE_PROBE_ORIENTATION ?? "1:1";

mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });

const ready = await readReadyz(pipelineUrl);
const model =
  process.env.PIPELINE_IMAGE_MODEL_DEFAULT ??
  (typeof ready.model === "string" && ready.model.trim() ? ready.model : "pornmaster-zimage-turbo");

const passthrough = process.argv.slice(2);
const probeArgs = [
  "run",
  "--filter",
  "@idream/gen",
  "probe:image",
  "--",
  ...defaultArg(passthrough, "prompt", prompt),
  ...defaultArg(passthrough, "count", count),
  ...defaultArg(passthrough, "model", model),
  ...defaultArg(passthrough, "orientation", orientation),
  ...defaultArg(passthrough, "report", report),
  ...passthrough,
];

const result = spawnSync("bun", probeArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    GEN_IMAGE_PROVIDER: "pipeline",
    PIPELINE_API_URL: pipelineUrl,
    PIPELINE_API_TOKEN: pipelineToken,
    PIPELINE_IMAGE_MODEL_DEFAULT: model,
    PIPELINE_IMAGE_SIZE_DEFAULT: imageSize,
    BLOB_ROOT: blobRoot,
  },
  stdio: "inherit",
});

process.exitCode = result.status ?? 1;

async function readReadyz(url) {
  try {
    const response = await fetch(`${url}/readyz`);
    if (!response.ok) {
      throw new Error(`GET /readyz returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      throw new Error(`GET /readyz returned ${JSON.stringify(payload)}`);
    }
    return payload;
  } catch (error) {
    process.stderr.write(
      [
        `Image pipeline gateway is not ready at ${url}.`,
        "Start the local gateway first, for example:",
        "  bun run --filter @idream/gen serve:sdcpp-image",
        "",
        error instanceof Error ? error.message : String(error),
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}

function defaultArg(args, name, value) {
  if (hasArg(args, name)) return [];
  return [`--${name}`, value];
}

function hasArg(args, name) {
  return args.some((arg, index) => arg === `--${name}` || arg.startsWith(`--${name}=`) || args[index - 1] === `--${name}`);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
