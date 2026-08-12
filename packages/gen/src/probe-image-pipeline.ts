import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  GenerationTerminalRecordIngest,
  ImageGeneratePayload,
} from "@idream/shared/contracts";
import { loadWorkflowDescriptors } from "./backend/workflow";
import { env } from "./env";
import { processImageGenerate } from "./pipeline";

type ProbeOptions = {
  prompt: string;
  negativePrompt: string | null;
  count: number;
  model: string;
  orientation: string;
  report: string | null;
};

type ProbeBackendBinding = {
  backendKind: "comfyui" | "drawthings" | null;
  backendTarget: string | null;
  workflowKey: string | null;
  workflowVersion: number | null;
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  const count = Number.parseInt(readArg("count") ?? "1", 10);
  return {
    prompt: readArg("prompt") ?? "high quality portrait, cinematic lighting",
    negativePrompt: readArg("negative-prompt") ?? null,
    count: Number.isFinite(count) ? Math.max(1, Math.min(count, 4)) : 1,
    model: readArg("model") ?? env.PIPELINE_IMAGE_MODEL_DEFAULT,
    orientation: readArg("orientation") ?? "1:1",
    report: readArg("report") ?? process.env.PIPELINE_IMAGE_PROBE_REPORT ?? null,
  };
}

async function main() {
  const options = readOptions();
  const startedAt = Date.now();
  const generationJobId = `probe_${randomUUID()}`;
  const attemptId = `attempt_${randomUUID()}`;
  const terminalIngests: GenerationTerminalRecordIngest[] = [];
  const backendBinding = await resolveProbeBackendBinding(options.model);
  const controls: Record<string, unknown> = {
    source: "probe-image-pipeline",
    ...(backendBinding.workflowKey && backendBinding.workflowVersion
      ? {
          workflowKey: backendBinding.workflowKey,
          workflowVersion: backendBinding.workflowVersion,
        }
      : {}),
  };

  // INVARIANT: keep this object typed as the actual queue contract. A future
  // required Attempt field must break typecheck here instead of leaving the
  // launch probe as a stale raw object that only fails after deployment.
  const payload: ImageGeneratePayload = {
    version: 1,
    kind: "image",
    requestId: `req_${generationJobId}`,
    generationJobId,
    attemptId,
    attemptNo: 1,
    provider: env.IMAGE_PROVIDER,
    userId: "probe-user",
    characterId: null,
    prompt: options.prompt,
    negativePrompt: options.negativePrompt,
    controls,
    presetIds: [],
    orientation: options.orientation,
    count: options.count,
    seed: `probe-${Date.now()}`,
    model: options.model,
    outputPrefix: `probe/${generationJobId}/`,
  };

  await processImageGenerate(
    payload,
    {
      acknowledgeTerminalRecord: async (input) => {
        terminalIngests.push(input);
      },
      recordTransportExecution: async () => undefined,
      attemptsMade: 0,
      maxAttempts: 1,
    },
  );

  const terminalIngest = terminalIngests[0];
  const terminalRecord = terminalIngest?.terminalRecord;
  const ok = terminalRecord?.outcome === "succeeded";
  const assets = terminalRecord?.outcome === "succeeded"
    ? terminalRecord.assets.length
    : 0;
  const error = terminalRecord?.outcome === "failed" || terminalRecord?.outcome === "unknown"
    ? terminalRecord.error
    : terminalRecord?.outcome === "blocked"
      ? terminalRecord.block
      : null;
  const report = {
    ok,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    provider: env.IMAGE_PROVIDER,
    pipelineUrl: env.PIPELINE_API_URL ?? null,
    backendKind: backendBinding.backendKind,
    backendTarget: backendBinding.backendTarget,
    workflowKey: backendBinding.workflowKey,
    workflowVersion: backendBinding.workflowVersion,
    model: options.model,
    orientation: options.orientation,
    count: options.count,
    blobAuthority: env.BLOB_AUTHORITY,
    blobRoot: env.BLOB_ROOT,
    generationJobId,
    terminal: terminalIngest
      ? {
          ref: terminalIngest.terminalRecordRef,
          checksum: terminalIngest.terminalRecordChecksum,
          outcome: terminalRecord?.outcome,
          assets,
          error,
        }
      : null,
  };

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (!ok) process.exitCode = 1;
}

if (isCliEntrypoint()) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function resolveProbeBackendBinding(
  model: string,
): Promise<ProbeBackendBinding> {
  if (env.IMAGE_PROVIDER !== "backend") {
    return {
      backendKind: null,
      backendTarget: null,
      workflowKey: null,
      workflowVersion: null,
    };
  }

  const descriptors = await loadWorkflowDescriptors(env.GEN_WORKFLOW_DIR);
  const descriptor = descriptors.find(
    (candidate) =>
      candidate.modelId === model || candidate.workflowKey === model,
  );
  if (!descriptor) {
    throw new Error(
      `Image launch probe model ${model} has no workflow descriptor in ${env.GEN_WORKFLOW_DIR}`,
    );
  }

  return {
    backendKind: descriptor.backendKind,
    backendTarget:
      descriptor.backendKind === "comfyui"
        ? env.COMFYUI_API_URL
        : env.DRAWTHINGS_CLI,
    workflowKey: descriptor.workflowKey,
    workflowVersion: descriptor.version,
  };
}

function isCliEntrypoint() {
  return (
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}
