import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  characterVideoProductionRecipe,
  characterVideoProductionRecipeForWorkflow,
  characterVideoProductionRecipes,
  type CharacterVideoProductionRecipe,
} from "@idream/shared";
import type {
  GenerationTerminalRecord,
  GenerationTerminalRecordIngest,
  VideoGeneratePayload,
} from "@idream/shared/contracts";
import { loadWorkflowDescriptors } from "./backend/workflow";
import { probeVideoMedia } from "./backend/video-media-probe";
import { env } from "./env";
import { processVideoGenerate } from "./pipeline";

type ProbeOptions = {
  readonly model: string;
  readonly prompt: string;
  readonly negativePrompt: string | null;
  readonly referencePath: string;
  readonly report: string | null;
  readonly seed: string;
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  const referencePath =
    readArg("reference") ?? process.env.VIDEO_GENERATION_PROBE_REFERENCE;
  if (!referencePath) {
    throw new Error(
      "Video launch probe requires --reference <reviewed character image> or VIDEO_GENERATION_PROBE_REFERENCE",
    );
  }
  return {
    model:
      readArg("model") ??
      (env.VIDEO_PROVIDER === "backend"
        ? characterVideoProductionRecipe.workflowKey
        : env.PIPELINE_VIDEO_MODEL_DEFAULT),
    prompt:
      readArg("prompt") ??
      "Subtle natural breathing and eye movement, fixed portrait camera",
    negativePrompt: readArg("negative-prompt") ?? null,
    referencePath: resolveWorkspacePath(referencePath),
    seed:
      readArg("seed") ??
      process.env.VIDEO_GENERATION_PROBE_SEED ??
      "probe-video-v1",
    report:
      readArg("report") ??
      process.env.VIDEO_GENERATION_PROBE_REPORT ??
      null,
  };
}

async function main() {
  const options = readOptions();
  const startedAt = Date.now();
  const generationJobId = `probe_video_${randomUUID()}`;
  const attemptId = `attempt_${randomUUID()}`;
  const requestId = `req_${generationJobId}`;
  const referenceBody = await readFile(options.referencePath);
  const binding = await resolveBackendBinding(options.model);
  const recipe = binding.recipe;
  const terminalIngests: GenerationTerminalRecordIngest[] = [];
  const controls = {
    source: "probe-video-generation",
    width: recipe.width,
    height: recipe.height,
    fps: recipe.fps,
    ...(binding.workflowKey && binding.workflowVersion
      ? {
          workflowKey: binding.workflowKey,
          workflowVersion: binding.workflowVersion,
        }
      : {}),
  };
  const payload: VideoGeneratePayload = {
    version: 1,
    kind: "video",
    requestId,
    generationJobId,
    attemptId,
    attemptNo: 1,
    provider: env.VIDEO_PROVIDER,
    userId: "probe-user",
    characterId: "probe-character",
    prompt: options.prompt,
    negativePrompt: options.negativePrompt,
    controls,
    seconds: recipe.durationSeconds,
    seed: options.seed,
    model: options.model,
    outputPrefix: `probe/${generationJobId}/`,
    referenceImages: [
      {
        assetId: `probe-reference-${createHash("sha256").update(referenceBody).digest("hex").slice(0, 16)}`,
        role: "source_image",
        b64Json: referenceBody.toString("base64"),
        contentType: contentTypeFromPath(options.referencePath),
      },
    ],
  };

  await processVideoGenerate(payload, {
    acknowledgeTerminalRecord: async (input) => {
      terminalIngests.push(input);
    },
    recordTransportExecution: async () => undefined,
    attemptsMade: 0,
    maxAttempts: 1,
  });

  const terminalIngest = terminalIngests[0];
  const terminalRecord = terminalIngest?.terminalRecord;
  const ok = terminalRecord?.outcome === "succeeded";
  const assets =
    terminalRecord?.outcome === "succeeded"
      ? terminalRecord.assets.length
      : 0;
  const error =
    terminalRecord?.outcome === "failed" || terminalRecord?.outcome === "unknown"
      ? terminalRecord.error
      : terminalRecord?.outcome === "blocked"
        ? terminalRecord.block
        : null;
  const artifact = await artifactEvidence(terminalRecord);
  const report = {
    ok,
    sourceRevision: env.SOURCE_REVISION?.trim() || null,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    provider: env.VIDEO_PROVIDER,
    backendKind: binding.backendKind,
    backendTarget: binding.backendTarget,
    workflowKey: binding.workflowKey,
    workflowVersion: binding.workflowVersion,
    model: options.model,
    seconds: recipe.durationSeconds,
    seed: options.seed,
    requestId,
    attemptId,
    referenceSha256: createHash("sha256").update(referenceBody).digest("hex"),
    blobAuthority: env.BLOB_AUTHORITY,
    generationJobId,
    artifact,
    terminal: terminalIngest
      ? {
          ref: terminalIngest.terminalRecordRef,
          checksum: terminalIngest.terminalRecordChecksum,
          outcome: terminalRecord?.outcome,
          assets,
          error,
          providerRequestId: terminalRecord?.providerRequestId ?? null,
        }
      : null,
  };

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function artifactEvidence(
  terminalRecord: GenerationTerminalRecord | undefined,
) {
  if (terminalRecord?.outcome !== "succeeded") return null;
  const asset = terminalRecord.assets[0];
  if (!asset) return null;
  const authority = env.BLOB_AUTHORITY;
  const localPath = authority.root
    ? path.join(authority.root, asset.key)
    : null;
  const body = localPath ? await readFile(localPath) : null;
  return {
    key: asset.key,
    providerKey: asset.providerKey ?? null,
    contentType: asset.contentType,
    seconds: asset.seconds ?? null,
    localPath,
    sizeBytes: body?.byteLength ?? null,
    sha256: body
      ? createHash("sha256").update(body).digest("hex")
      : null,
    verifiedVideo:
      body && env.VIDEO_PROVIDER === "backend"
        ? await probeVideoMedia(body)
        : null,
  };
}

async function resolveBackendBinding(model: string) {
  if (env.VIDEO_PROVIDER !== "backend") {
    return {
      backendKind: null,
      backendTarget: null,
      workflowKey: null,
      workflowVersion: null,
      recipe: productionRecipeForModel(model) ?? characterVideoProductionRecipe,
    } as const;
  }
  const descriptors = await loadWorkflowDescriptors(env.GEN_WORKFLOW_DIR);
  const descriptor = descriptors.find(
    (candidate) =>
      candidate.modelId === model || candidate.workflowKey === model,
  );
  if (!descriptor) {
    throw new Error(
      `Video launch probe model ${model} has no workflow descriptor in ${env.GEN_WORKFLOW_DIR}`,
    );
  }
  const recipe = characterVideoProductionRecipeForWorkflow(
    descriptor.workflowKey,
  );
  if (!recipe) {
    throw new Error(
      `Video launch probe model ${model} is not an authorized production video recipe`,
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
    recipe,
  } as const;
}

function productionRecipeForModel(
  model: string,
): CharacterVideoProductionRecipe | null {
  return characterVideoProductionRecipes.find(
    (recipe) =>
      recipe.workflowKey === model ||
      recipe.pipelineModel === model ||
      recipe.profileKey === model,
  ) ?? null;
}

function contentTypeFromPath(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
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

function isCliEntrypoint() {
  return (
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isCliEntrypoint()) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
