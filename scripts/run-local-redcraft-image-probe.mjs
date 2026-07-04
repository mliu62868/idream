#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const pipelineUrl = trimTrailingSlash(process.env.REDCRAFT_PIPELINE_API_URL ?? process.env.PIPELINE_API_URL ?? "http://127.0.0.1:8092");
const pipelineToken = process.env.PIPELINE_API_TOKEN ?? process.env.COMFYUI_IMAGE_API_TOKEN ?? "";
const imageSize = process.env.PIPELINE_IMAGE_SIZE_DEFAULT ?? "256x384";
const blobRoot = process.env.BLOB_ROOT ?? path.join(repoRoot, ".tmp/probe-blob");
const report = process.env.REDCRAFT_PIPELINE_IMAGE_PROBE_REPORT ?? ".tmp/launch-redcraft-image-probe.json";
const prompt =
  process.env.REDCRAFT_PIPELINE_IMAGE_PROBE_PROMPT ??
  "adult woman portrait, consistent character, oval face, hazel eyes, long auburn hair, natural daylight, realistic photo, high detail";
const count = process.env.REDCRAFT_PIPELINE_IMAGE_PROBE_COUNT ?? "1";
const orientation = process.env.REDCRAFT_PIPELINE_IMAGE_PROBE_ORIENTATION ?? "3:4";

mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });

const ready = await readReadyz(pipelineUrl);
const model =
  process.env.PIPELINE_IMAGE_MODEL_DEFAULT ??
  (typeof ready.model === "string" && ready.model.trim() ? ready.model : "redcraft-krea2-comfyui");

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
        `Redcraft image pipeline gateway is not ready at ${url}.`,
        "Start ComfyUI CPU, then start the local gateway, for example:",
        "  cd \"/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI\"",
        "  .venv/bin/python main.py --listen 127.0.0.1 --port 8191 --extra-model-paths-config /Users/kk/code/idream/packages/gen/workflows/comfy-extra-models-idream.yaml --cpu --force-fp32 --fp32-vae --fp32-text-enc --preview-method none --disable-auto-launch",
        "  cd /Users/kk/code/idream",
        "  bun run --filter @idream/gen serve:comfyui-image",
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
