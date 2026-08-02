// SPEC: manual smoke proving one ComfyUI workflow descriptor still produces a
// non-degenerate PNG on a live ComfyUI (default: the CPU instance on 8191).
// Emits a JSON report and exits non-zero on failure so it composes as a CLI gate.
// INTENT: drives `providers.image.generate` — the exact seam the production gen
// worker uses — instead of re-implementing ComfyUI's /prompt -> /history -> /view
// protocol a second time. It previously carried its own submit/poll/fetch client
// plus a hardcoded node-id prompt binder ("4"/"6"/"7") that happened to agree
// with one descriptor's graph numbering and no other; every ComfyUI API change
// had to be made twice and only backend/comfyui.ts had tests.
// INVARIANTS: never mutates the caller's ComfyUI; writes the PNG only when
// --output is given. --workflow still takes a descriptor PATH (the registry is
// pointed at its directory and the descriptor supplies the model id + pin), so
// the documented `launch:probe:redcraft-comfyui` invocation is unchanged.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type ProbeOptions = {
  url: string;
  workflowPath: string;
  prompt: string;
  reportPath: string | null;
  outputPath: string | null;
  width: number;
  height: number;
  steps: number;
  seed: number;
  timeoutMs: number;
};

type ProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  comfyuiUrl: string;
  workflowPath: string;
  modelId: string | null;
  promptId: string | null;
  outputPath: string | null;
  image: {
    width: number;
    height: number;
    contentType: string;
    bytes: number;
  } | null;
  error: { code: string; message: string; retryable: boolean } | null;
};

const defaultPrompt =
  "adult woman portrait, consistent character, oval face, hazel eyes, long auburn hair, natural daylight, realistic photo, high detail";

const options = readOptions();

// Must happen before providers/env are evaluated by the dynamic imports below.
process.env.GEN_IMAGE_PROVIDER = "backend";
process.env.COMFYUI_API_URL = options.url;
process.env.GEN_WORKFLOW_DIR = path.dirname(options.workflowPath);
process.env.PIPELINE_TIMEOUT_MS = String(options.timeoutMs);

const { providers } = await import("./providers");
const { assertGeneratedImageSanity } = await import(
  "@idream/shared/media/generated-image-sanity"
);

async function main() {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  let report: ProbeReport;

  try {
    const pin = await readWorkflowPin(options.workflowPath);
    const result = await providers.image.generate({
      model: pin.modelId,
      prompt: options.prompt,
      count: 1,
      seed: String(options.seed),
      controls: {
        workflowKey: pin.workflowKey,
        workflowVersion: pin.version,
        width: options.width,
        height: options.height,
        steps: options.steps,
      },
    });

    if (!result.ok) {
      throw new ProbeError(result.error.code, result.error.message, result.error.retryable);
    }
    const asset = result.data.assets[0];
    if (!asset?.body) {
      throw new ProbeError(
        "comfyui_missing_output",
        "Backend returned no image bytes",
        false,
      );
    }

    assertGeneratedImageSanity(
      Buffer.from(asset.body),
      `redcraft comfyui ${pin.modelId}`,
    );
    if (options.outputPath) {
      await mkdir(path.dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, asset.body);
    }

    report = {
      ok: true,
      checkedAt,
      durationMs: Date.now() - startedAt,
      comfyuiUrl: options.url,
      workflowPath: options.workflowPath,
      modelId: pin.modelId,
      promptId: result.invocation?.providerRequestId ?? null,
      outputPath: options.outputPath,
      image: {
        width: asset.width,
        height: asset.height,
        contentType: asset.contentType ?? "image/png",
        bytes: asset.body.byteLength,
      },
      error: null,
    };
  } catch (error) {
    const probeError = toProbeError(error);
    report = {
      ok: false,
      checkedAt,
      durationMs: Date.now() - startedAt,
      comfyuiUrl: options.url,
      workflowPath: options.workflowPath,
      modelId: null,
      promptId: null,
      outputPath: options.outputPath,
      image: null,
      error: {
        code: probeError.code,
        message: probeError.message,
        retryable: probeError.retryable,
      },
    };
  }

  if (options.reportPath) {
    await mkdir(path.dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

// SPEC: the descriptor file is the probe's only source of model id and workflow
// pin — gen fails closed on an unpinned attempt, so the probe must pin the very
// descriptor it was pointed at.
async function readWorkflowPin(workflowPath: string) {
  const parsed = JSON.parse(await readFile(workflowPath, "utf8")) as unknown;
  const record = typeof parsed === "object" && parsed !== null
    ? parsed as Record<string, unknown>
    : {};
  const modelId = typeof record.modelId === "string" ? record.modelId : "";
  const workflowKey = typeof record.workflowKey === "string" ? record.workflowKey : "";
  const version = typeof record.version === "number" ? record.version : 0;
  if (!modelId || !workflowKey || !version) {
    throw new ProbeError(
      "invalid_workflow",
      `Workflow ${workflowPath} is missing modelId/workflowKey/version`,
      false,
    );
  }
  return { modelId, workflowKey, version };
}

function readOptions(): ProbeOptions {
  return {
    url: trimTrailingSlash(readArg("url") ?? process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8191"),
    workflowPath: resolveWorkspacePath(
      readArg("workflow") ?? "packages/gen/workflows/redcraft-krea2-redmix3-txt2img.json",
    ),
    prompt: readArg("prompt") ?? defaultPrompt,
    reportPath: optionalResolvedPath(readArg("report")),
    outputPath: optionalResolvedPath(readArg("output")),
    width: numberArg("width", 256),
    height: numberArg("height", 384),
    steps: numberArg("steps", 2),
    seed: numberArg("seed", 123456789),
    timeoutMs: numberArg("timeout-ms", 10 * 60 * 1000),
  };
}

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArg(name: string, fallback: number) {
  const value = readArg(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveWorkspacePath(filePath: string) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot(), filePath);
}

function optionalResolvedPath(filePath: string | undefined) {
  return filePath ? resolveWorkspacePath(filePath) : null;
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (current.endsWith("idream")) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

class ProbeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

function toProbeError(error: unknown) {
  if (error instanceof ProbeError) return error;
  if (error instanceof Error) return new ProbeError("redcraft_comfyui_probe_failed", error.message, true);
  return new ProbeError("redcraft_comfyui_probe_failed", String(error), true);
}

main().catch((error: unknown) => {
  const probeError = toProbeError(error);
  process.stderr.write(`${probeError.code}: ${probeError.message}\n`);
  process.exitCode = 1;
});
