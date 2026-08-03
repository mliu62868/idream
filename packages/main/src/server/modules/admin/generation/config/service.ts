import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  dimensionsForImageOrientation,
  imageOrientations,
} from "@/server/modules/ourdream/generation-dimensions";
import { workflowKeyExists } from "@/server/modules/generation/generation-catalog";
import { actorWithPermission, jsonBody, toInputJson, writeAudit } from "@/server/modules/admin/shared/legacy-primitives";
import { redactGenerationJob as redactJob } from "@/server/modules/admin/shared/presenters";
import { decodeAdminListCursor, encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt,
} from "@/server/modules/generation/generation-attempt-authority";

export function modelDiagnosticsEnabled() {
  return process.env.ADMIN_MODEL_DIAGNOSTICS_ENABLED === "true";
}

async function featureEnabled(key: string) {
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  return Boolean(flag?.enabled);
}
// SPEC: the only legal GenerationModelProfile.runner values. Mirrors the enum
// comment in prisma/schema.prisma; generation-runner-vocabulary.test.ts asserts
// the two lists are the same set and that gen can map every one of them.
// INTENT: a runner picks gen's adapter layer only — the concrete backend comes
// from the workflow descriptor's backendKind.
export const GENERATION_PROFILE_RUNNERS = [
  "pipeline",
  "mlx",
  "comfyui",
  "external",
] as const;

const modelProfileSchema = z.object({
  profileKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  mode: z.enum(["image", "video"]).default("image"),
  runner: z.enum(GENERATION_PROFILE_RUNNERS).default("comfyui"),
  pipelineModel: z.string().trim().min(1).max(160),
  workflowKey: z.string().trim().min(1).max(160).nullable().optional(),
  sourceModelPath: z.string().trim().max(500).nullable().optional(),
  convertedModelPath: z.string().trim().max(500).nullable().optional(),
  modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).default("safetensors"),
  runnerConfig: z.record(z.string(), z.unknown()).optional(),
  defaultWidth: z.number().int().min(128).max(4096).default(768),
  defaultHeight: z.number().int().min(128).max(4096).default(1024),
  allowedOrientations: z.array(z.enum(imageOrientations)).min(1).max(12),
  steps: z.number().int().min(1).max(150).default(28),
  sampler: z.string().trim().min(1).max(80).default("euler"),
  scheduler: z.string().trim().min(1).max(80).default("model_default"),
  cfgScale: z.number().min(1).max(30).default(1),
  costMultiplier: z.number().min(0.1).max(20).default(1),
  requiredEntitlement: z.string().trim().max(120).nullable().optional(),
  maxCount: z.number().int().min(1).max(8).default(4),
  concurrencyLimit: z.number().int().min(1).max(100).default(1),
  enabled: z.boolean().default(false),
  rolloutPercent: z.number().int().min(0).max(100).default(0),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const modelProfilePatchSchema = z.object({
  profileKey: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["image", "video"]).optional(),
  runner: z.enum(GENERATION_PROFILE_RUNNERS).optional(),
  pipelineModel: z.string().trim().min(1).max(160).optional(),
  workflowKey: z.string().trim().min(1).max(160).nullable().optional(),
  sourceModelPath: z.string().trim().max(500).nullable().optional(),
  convertedModelPath: z.string().trim().max(500).nullable().optional(),
  modelFormat: z.enum(["safetensors", "gguf", "diffusers", "external"]).optional(),
  runnerConfig: z.record(z.string(), z.unknown()).optional(),
  defaultWidth: z.number().int().min(128).max(4096).optional(),
  defaultHeight: z.number().int().min(128).max(4096).optional(),
  allowedOrientations: z.array(z.enum(imageOrientations)).min(1).max(12).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  sampler: z.string().trim().min(1).max(80).optional(),
  scheduler: z.string().trim().min(1).max(80).optional(),
  cfgScale: z.number().min(1).max(30).optional(),
  costMultiplier: z.number().min(0.1).max(20).optional(),
  requiredEntitlement: z.string().trim().max(120).nullable().optional(),
  maxCount: z.number().int().min(1).max(8).optional(),
  concurrencyLimit: z.number().int().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(3).max(2_000).optional(),
  confirmation: z.string().trim().min(1).max(160).optional(),
});

const modelProfileTestJobSchema = z.object({
  prompt: z.string().trim().max(2_000).optional(),
  negativePrompt: z.string().trim().max(1_000).nullable().optional(),
  orientation: z.string().trim().min(1).max(20).optional(),
  outputCount: z.number().int().min(1).max(4).default(1),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const modelImportKindSchema = z.enum(["model", "lora", "llm", "vae"]);

const modelImportRegisterSchema = z.object({
  kind: modelImportKindSchema.default("model"),
  path: z.string().trim().min(1).max(1_000),
  copyToLibrary: z.boolean().default(false),
  reason: z.string().trim().min(3).max(2_000).optional(),
});

const publishSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
  dryRunSummary: z.record(z.string(), z.unknown()).optional(),
});

const imageProfilePublishMinSamples = 20;
const modelProfilePublishMinRate = 0.8;

const rollbackSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const modelProfileListQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(["image", "video"]).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export async function listModelProfiles(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const url = new URL(request.url);
  const query = modelProfileListQuerySchema.parse(Object.fromEntries(url.searchParams));
  const { search, mode, status } = query;
  const limit = query.limit ?? null;
  const queryIdentity = { search, mode, status };
  const cursorKeys = adminListCursorKeys(url, "generation_profiles", queryIdentity);
  const cursorWhere: Prisma.GenerationModelProfileWhereInput | undefined = cursorKeys ? (() => {
    const profileKey = adminCursorString(cursorKeys, 0, "generation_profiles");
    const version = adminCursorNumber(cursorKeys, 1, "generation_profiles");
    const id = adminCursorString(cursorKeys, 2, "generation_profiles");
    return { OR: [
      { profileKey: { gt: profileKey } },
      { profileKey, version: { lt: version } },
      { profileKey, version, id: { gt: id } },
    ] };
  })() : undefined;
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode,
      status,
      OR: search
        ? [{ id: { contains: search } }, { profileKey: { contains: search } }, { label: { contains: search } }]
        : undefined,
      AND: cursorWhere,
    },
    orderBy: [{ profileKey: "asc" }, { version: "desc" }, { id: "asc" }],
    take: limit === null ? undefined : limit + 1,
    select: {
      id: true,
      profileKey: true,
      label: true,
      mode: true,
      runner: true,
      pipelineModel: true,
      workflowKey: true,
      sourceModelPath: true,
      convertedModelPath: true,
      modelFormat: true,
      runnerConfig: true,
      defaultWidth: true,
      defaultHeight: true,
      allowedOrientations: true,
      steps: true,
      sampler: true,
      scheduler: true,
      cfgScale: true,
      costMultiplier: true,
      requiredEntitlement: true,
      maxCount: true,
      concurrencyLimit: true,
      enabled: true,
      rolloutPercent: true,
      version: true,
      status: true,
      dryRunSummary: true,
      publishedAt: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const page = limit === null ? profiles : profiles.slice(0, limit);
  return ok({
    items: page,
    pageInfo: adminListPageInfo("generation_profiles", queryIdentity, page, limit !== null && profiles.length > limit, (row) => [
      row.profileKey,
      row.version,
      row.id,
    ]),
  });
}

type ModelImportKind = z.infer<typeof modelImportKindSchema>;

type ModelImportAsset = {
  kind: ModelImportKind;
  name: string;
  path: string;
  format: "safetensors" | "gguf";
  sizeBytes: number;
  modifiedAt: string;
  draftPatch: Record<string, unknown>;
};

type ModelImportRegistryEntry = {
  kind: ModelImportKind;
  path: string;
  registeredAt: string;
};

type ModelImportRegistry = {
  version: 1;
  assets: ModelImportRegistryEntry[];
};

const modelImportRegistrySchema = z.object({
  version: z.number().optional(),
  assets: z
    .array(
      z.object({
        kind: modelImportKindSchema,
        path: z.string().trim().min(1).max(1_000),
        registeredAt: z.string().trim().optional(),
      }),
    )
    .default([]),
});

const IMPORT_EXTENSIONS: Record<ModelImportKind, string[]> = {
  model: [".safetensors", ".gguf"],
  lora: [".safetensors"],
  llm: [".gguf", ".safetensors"],
  vae: [".safetensors", ".gguf"],
};

export async function listModelImports(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const dirs = modelImportDirs();
  const scannedItems = (
    await Promise.all((["model", "lora", "llm", "vae"] as const).map((kind) => scanImportDir(kind, dirs[kind])))
  ).flat();
  const registeredItems = await registeredModelImportAssets();
  const items = dedupeModelImportAssets([...scannedItems, ...registeredItems]);
  return ok({
    roots: dirs,
    maxUploadBytes: modelUploadMaxBytes(),
    items: items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
  });
}

export async function registerModelImport(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelImportRegisterSchema.parse(await jsonBody(request));
  const { assets, sourceType, resolvedPath } = await modelImportAssetsFromPath(body.kind, body.path);
  await upsertModelImportRegistryEntries(assets);
  await writeAudit(request, actor, {
    action: sourceType === "directory" ? "generation.model_import.register_directory" : "generation.model_import.register",
    targetType: sourceType === "directory" ? `generation_${body.kind}_asset_directory` : `generation_${body.kind}_asset`,
    targetId: resolvedPath,
    reason: body.reason,
    after: {
      kind: body.kind,
      sourceType,
      count: assets.length,
      assets: assets.slice(0, 50).map((asset) => ({
        path: asset.path,
        format: asset.format,
        sizeBytes: asset.sizeBytes,
      })),
    },
  });
  return ok({ asset: assets[0], assets, roots: modelImportDirs() });
}

async function registeredModelImportAssets() {
  const registry = await readModelImportRegistry();
  const assets = await Promise.all(
    registry.assets.map(async (entry) => {
      try {
        return await modelImportAssetFromPath(entry.kind, entry.path);
      } catch {
        return null;
      }
    }),
  );
  return assets.filter((asset): asset is ModelImportAsset => asset !== null);
}

async function upsertModelImportRegistryEntries(assets: ModelImportAsset[]) {
  const registry = await readModelImportRegistry();
  const incomingKeys = new Set(assets.map((asset) => registryEntryKey(asset.kind, asset.path)));
  const existing = registry.assets.filter(
    (entry) => !incomingKeys.has(registryEntryKey(entry.kind, entry.path)),
  );
  await writeModelImportRegistry({
    version: 1,
    assets: [
      ...existing,
      ...assets.map((asset) => ({
        kind: asset.kind,
        path: asset.path,
        registeredAt: new Date().toISOString(),
      })),
    ],
  });
}

async function readModelImportRegistry(): Promise<ModelImportRegistry> {
  const registryPath = modelImportRegistryPath();
  const text = await readFile(registryPath, "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (!text) return { version: 1, assets: [] };

  try {
    const parsed = modelImportRegistrySchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) return { version: 1, assets: [] };
    return {
      version: 1,
      assets: parsed.data.assets.map((entry) => ({
        kind: entry.kind,
        path: path.resolve(/*turbopackIgnore: true*/ expandHome(entry.path)),
        registeredAt: entry.registeredAt ?? new Date(0).toISOString(),
      })),
    };
  } catch {
    return { version: 1, assets: [] };
  }
}

async function writeModelImportRegistry(registry: ModelImportRegistry) {
  const registryPath = modelImportRegistryPath();
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify({ version: 1, assets: dedupeRegistryEntries(registry.assets) }, null, 2)}\n`,
    "utf8",
  );
}

function modelImportRegistryPath() {
  return path.join(modelImportDirs().root, "registry.json");
}

function dedupeModelImportAssets(items: ModelImportAsset[]) {
  const byKey = new Map<string, ModelImportAsset>();
  for (const item of items) {
    byKey.set(`${item.kind}:${item.path}`, item);
  }
  return Array.from(byKey.values());
}

function dedupeRegistryEntries(entries: ModelImportRegistryEntry[]) {
  const byKey = new Map<string, ModelImportRegistryEntry>();
  for (const entry of entries) {
    const resolvedPath = path.resolve(/*turbopackIgnore: true*/ expandHome(entry.path));
    byKey.set(registryEntryKey(entry.kind, resolvedPath), { ...entry, path: resolvedPath });
  }
  return Array.from(byKey.values());
}

function registryEntryKey(kind: ModelImportKind, filePath: string) {
  return `${kind}:${path.resolve(/*turbopackIgnore: true*/ expandHome(filePath))}`;
}

function isMissingFileError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function uploadModelImport(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const form = await request.formData();
  const kind = modelImportKindSchema.parse(String(form.get("kind") ?? "model"));
  const file = form.get("file");
  if (!(file instanceof File)) throw Errors.badRequest("Upload requires a file field");
  if (file.size <= 0) throw Errors.badRequest("Uploaded file is empty");
  const maxBytes = modelUploadMaxBytes();
  if (file.size > maxBytes) {
    throw Errors.badRequest(`Uploaded file exceeds limit (${maxBytes} bytes)`);
  }

  const safeName = safeImportFileName(file.name);
  assertImportExtension(kind, safeName);
  const targetDir = modelImportDirs()[kind];
  await mkdir(targetDir, { recursive: true });
  const destination = await uniqueImportPath(targetDir, safeName);
  const webStream = file.stream() as unknown as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(webStream), createWriteStream(destination));
  const asset = await modelImportAssetFromPath(kind, destination);

  await writeAudit(request, actor, {
    action: "generation.model_import.upload",
    targetType: `generation_${kind}_asset`,
    targetId: asset.path,
    after: {
      kind: asset.kind,
      format: asset.format,
      name: asset.name,
      sizeBytes: asset.sizeBytes,
    },
  });
  return ok({ asset, roots: modelImportDirs() });
}

function modelImportRoot() {
  const configuredRoot = process.env.ADMIN_MODEL_LIBRARY_DIR?.trim();
  const defaultBase = process.env.IDREAM_REPO_ROOT?.trim() || process.cwd();
  const baseRoot = path.resolve(/*turbopackIgnore: true*/ expandHome(defaultBase));
  if (!configuredRoot) return path.join(baseRoot, "data", "model-imports");

  const expandedRoot = expandHome(configuredRoot);
  const resolvedRoot = path.isAbsolute(expandedRoot)
    ? expandedRoot
    : path.join(/*turbopackIgnore: true*/ baseRoot, expandedRoot);
  return path.resolve(/*turbopackIgnore: true*/ resolvedRoot);
}

function modelUploadMaxBytes() {
  const raw = Number.parseInt(process.env.ADMIN_MODEL_UPLOAD_MAX_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 1024 * 1024 * 1024;
}

function modelImportDirs() {
  const root = modelImportRoot();
  return {
    root,
    model: path.join(root, "checkpoints"),
    lora: path.join(root, "loras"),
    llm: path.join(root, "encoders"),
    vae: path.join(root, "vae"),
    converted: path.join(root, "gguf"),
  };
}

function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function scanImportDir(kind: ModelImportKind, dir: string, depth = 0): Promise<ModelImportAsset[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const assets: ModelImportAsset[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 2) {
      assets.push(...(await scanImportDir(kind, fullPath, depth + 1)));
      continue;
    }
    if (!entry.isFile() || !isAllowedImportFile(kind, entry.name)) continue;
    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) continue;
    assets.push(await modelImportAsset(kind, fullPath, info.size, info.mtime));
    if (assets.length >= 300) break;
  }
  return assets;
}

async function modelImportAssetFromPath(kind: ModelImportKind, rawPath: string) {
  const filePath = path.resolve(/*turbopackIgnore: true*/ expandHome(rawPath));
  assertImportExtension(kind, filePath);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw Errors.badRequest("Model import path must point to a readable file");
  return modelImportAsset(kind, filePath, info.size, info.mtime);
}

async function modelImportAssetsFromPath(kind: ModelImportKind, rawPath: string) {
  const resolvedPath = path.resolve(/*turbopackIgnore: true*/ expandHome(rawPath));
  const info = await stat(resolvedPath).catch(() => null);
  if (!info) throw Errors.badRequest("Model import path must point to a readable file or directory");
  if (info.isFile()) {
    return {
      sourceType: "file" as const,
      resolvedPath,
      assets: [await modelImportAssetFromPath(kind, resolvedPath)],
    };
  }
  if (!info.isDirectory()) {
    throw Errors.badRequest("Model import path must point to a readable file or directory");
  }
  const assets = await scanImportDir(kind, resolvedPath);
  if (assets.length === 0) {
    throw Errors.badRequest(`${kind} directory import found no supported files`);
  }
  return {
    sourceType: "directory" as const,
    resolvedPath,
    assets,
  };
}

async function modelImportAsset(
  kind: ModelImportKind,
  filePath: string,
  sizeBytes: number,
  modifiedAt: Date,
): Promise<ModelImportAsset> {
  const format = modelFormatFromPath(filePath);
  const metadataText =
    format === "safetensors" ? await readSafetensorsMetadataText(filePath) : "";
  return {
    kind,
    name: path.basename(filePath),
    path: filePath,
    format,
    sizeBytes,
    modifiedAt: modifiedAt.toISOString(),
    draftPatch: modelImportDraftPatch(kind, filePath, format, metadataText),
  };
}

function modelImportDraftPatch(
  kind: ModelImportKind,
  filePath: string,
  format: "safetensors" | "gguf",
  metadataText = "",
): Record<string, unknown> {
  const slug = slugFromFilePath(filePath);
  if (kind === "lora") {
    return {
      loraModelDir: path.dirname(filePath),
      lora: {
        key: slug,
        path: filePath,
        fileName: path.basename(filePath),
        weight: 1,
        enabled: true,
      },
    };
  }
  if (kind === "llm") return { llmPath: filePath };
  if (kind === "vae") return { vaePath: filePath };

  const isComfyuiFp8Krea2Import = isComfyuiFp8Krea2ModelImport(slug, filePath, metadataText);
  if (isComfyuiFp8Krea2Import) {
    return {
      profileTemplate: "reference_identity_comfyui",
      profileKey: `comfyui_${slug}`,
      label: `${titleFromSlug(slug)} ComfyUI candidate`,
      runner: "comfyui",
      pipelineModel: slug,
      sourceModelPath: filePath,
      diffusionModelPath: filePath,
      convertedModelPath: "",
      modelFormat: format,
      conversionEnabled: false,
      steps: "10",
      sampler: "er_sde",
      scheduler: "simple",
      cfgScale: "1",
      runnerConfig: {
        apiModelId: slug,
        profileTemplate: "reference_identity_comfyui",
        templateIntent: "comfyui_reference_identity",
        verificationStatus: "requires_comfyui_fp8_krea2_runtime",
        componentStatus: {
          workflow: "metadata_embedded_not_imported",
          textEncoder: "requires_comfyui_qwen3vl_text_encoder",
          vae: "requires_comfyui_krea2_vae",
        },
        assetFormat: "fp8_scaled_comfyui_checkpoint",
        note: "This Krea2 asset is a ComfyUI fp8-scaled checkpoint. Keep it as a ComfyUI draft until an imported workflow and local runtime probe pass.",
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
    };
  }
  // INTENT: an unrecognized checkpoint drafts as a plain ComfyUI profile. The old
  // fallback drafted an sd.cpp profile carrying a GGUF conversion step and sd.cpp
  // CLI arguments (llmPath / vaePath / backend=vae=cpu); that runner is retired and
  // its conversion apparatus went with it, so the draft would have described a
  // profile nothing can execute. ComfyUI is the backend that loads a raw checkpoint.
  return {
    profileKey: `comfyui_${slug}`,
    label: titleFromSlug(slug),
    runner: "comfyui",
    pipelineModel: slug,
    sourceModelPath: filePath,
    diffusionModelPath: filePath,
    convertedModelPath: "",
    modelFormat: format,
    conversionEnabled: false,
  };
}

function isComfyuiFp8Krea2ModelImport(slug: string, filePath: string, metadataText: string) {
  const haystack = `${slug} ${filePath} ${metadataText}`.toLowerCase();
  return (
    /krea[-_ ]?2/i.test(haystack) &&
    (haystack.includes("comfyui") || haystack.includes("checkpointloadersimple")) &&
    (haystack.includes("fp8") || haystack.includes("fp8_scaled") || haystack.includes("comfy_quant"))
  );
}

async function readSafetensorsMetadataText(filePath: string) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    const sizeBuffer = Buffer.alloc(8);
    await handle.read(sizeBuffer, 0, 8, 0);
    const headerLength = Number(sizeBuffer.readBigUInt64LE(0));
    if (!Number.isFinite(headerLength) || headerLength <= 0 || headerLength > 8 * 1024 * 1024) {
      return "";
    }
    const headerBuffer = Buffer.alloc(headerLength);
    await handle.read(headerBuffer, 0, headerLength, 8);
    const header = JSON.parse(headerBuffer.toString("utf8")) as unknown;
    if (!isRecord(header)) return "";
    const metadata = isRecord(header.__metadata__) ? header.__metadata__ : {};
    const metadataText = Object.entries(metadata)
      .map(([key, value]) => `${key}:${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n");
    return metadataText.slice(0, 80_000);
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function safeImportFileName(name: string) {
  const baseName = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (!baseName || baseName === "." || baseName === "..") {
    throw Errors.badRequest("Uploaded file name is invalid");
  }
  return baseName;
}

async function uniqueImportPath(dir: string, name: string) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate =
      attempt === 0
        ? path.join(dir, name)
        : path.join(dir, `${base}-${randomUUID().slice(0, 8)}${ext}`);
    const exists = await stat(candidate).then(
      () => true,
      () => false,
    );
    if (!exists) return candidate;
  }
  throw Errors.badRequest("Could not allocate a unique upload file name");
}

function assertImportExtension(kind: ModelImportKind, filePath: string) {
  if (!isAllowedImportFile(kind, filePath)) {
    throw Errors.badRequest(`${kind} import supports ${IMPORT_EXTENSIONS[kind].join(", ")} files`);
  }
}

function isAllowedImportFile(kind: ModelImportKind, filePath: string) {
  const lower = filePath.toLowerCase();
  return IMPORT_EXTENSIONS[kind].some((ext) => lower.endsWith(ext));
}

function modelFormatFromPath(filePath: string): "safetensors" | "gguf" {
  return filePath.toLowerCase().endsWith(".gguf") ? "gguf" : "safetensors";
}

function slugFromFilePath(filePath: string) {
  return (
    path
      .basename(filePath)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 90) || "model"
  );
}

function titleFromSlug(slug: string) {
  return slug
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function assertTargetConfirmation(value: string, targetId: string) {
  if (value !== targetId) throw Errors.badRequest("Confirmation did not match target");
}

// SPEC: P2 Task 7 —— workflowKey（可空）指向 gen workflow 描述符（packages/gen/workflows），
// 供入队时覆盖 profile.pipelineModel 路由到具体 workflow。留空/null 表示"沿用 pipelineModel"
// （不校验，因为它就是不引用任何 workflow）。非空必须命中已知描述符，否则 400。
// INVARIANT: 复用 generation-catalog.ts 的 60s 描述符缓存（workflowKeyExists），不重复扫目录。
async function assertKnownWorkflowKey(workflowKey: string | null | undefined) {
  if (!workflowKey) return;
  if (!(await workflowKeyExists(workflowKey))) {
    throw Errors.badRequest("Unknown workflowKey", { workflowKey });
  }
}

export async function createModelProfile(request: Request) {
  if (!modelDiagnosticsEnabled()) throw Errors.notFound("Admin API route not found");
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelProfileSchema.parse(await jsonBody(request));
  await assertKnownWorkflowKey(body.workflowKey);
  const runnerConfig = body.runnerConfig;
  const latest = await prisma.generationModelProfile.findFirst({
    where: { profileKey: body.profileKey },
    orderBy: { version: "desc" },
  });
  const profile = await prisma.generationModelProfile.create({
    data: {
      ...body,
      workflowKey: body.workflowKey ?? null,
      requiredEntitlement: body.requiredEntitlement ?? null,
      sourceModelPath: body.sourceModelPath ?? null,
      convertedModelPath: body.convertedModelPath ?? null,
      allowedOrientations: toInputJson(body.allowedOrientations),
      runnerConfig: runnerConfig ? toInputJson(runnerConfig) : undefined,
      dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
      version: (latest?.version ?? 0) + 1,
      status: "draft",
    },
  });
  await writeAudit(request, actor, {
    action: "generation.profile.create",
    targetType: "generation_model_profile",
    targetId: profile.id,
    after: { profileKey: profile.profileKey, version: profile.version, status: profile.status },
  });
  return ok({ profile });
}

export async function patchModelProfile(request: Request, id: string) {
  const body = modelProfilePatchSchema.parse(await jsonBody(request));
  if (!modelDiagnosticsEnabled() && !isOperationalModelProfileDisablePatch(body)) {
    throw Errors.notFound("Admin API route not found");
  }
  const actor = await actorWithPermission(request, "generation.config.write");
  const before = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Model profile not found");
  if (before.status !== "draft") {
    const forbiddenKeys = definedPatchKeys(body).filter(
      (key) => !["enabled", "reason", "confirmation"].includes(key),
    );
    if (body.enabled !== false || forbiddenKeys.length > 0) {
      throw Errors.badRequest("Only draft profiles can be edited; active profiles may only be disabled");
    }
  } else if (body.enabled === true) {
    throw Errors.badRequest("Draft profiles cannot be enabled directly; publish the profile after verification");
  }
  if (body.enabled === false && before.enabled) {
    if (!body.reason || !body.confirmation) {
      throw Errors.badRequest("Disabling a profile requires reason and target confirmation");
    }
    assertTargetConfirmation(body.confirmation, before.id);
  }
  // INVARIANT: a disable-only PATCH (the emergency kill-switch) must not rewrite
  // runnerConfig. Only carry it forward when the patch actually touches the runner
  // shape, so disabling a misbehaving profile never depends on its config parsing.
  const shouldPersistRunnerConfig =
    body.runnerConfig !== undefined || body.pipelineModel !== undefined || body.runner !== undefined;
  const runnerConfig = shouldPersistRunnerConfig
    ? body.runnerConfig ?? jsonRecord(before.runnerConfig)
    : undefined;
  await assertKnownWorkflowKey(body.workflowKey);

  const updated = await prisma.generationModelProfile.update({
    where: { id },
    data: {
      profileKey: body.profileKey,
      label: body.label,
      mode: body.mode,
      runner: body.runner,
      pipelineModel: body.pipelineModel,
      workflowKey: body.workflowKey === undefined ? undefined : body.workflowKey,
      sourceModelPath: body.sourceModelPath === undefined ? undefined : body.sourceModelPath,
      convertedModelPath:
        body.convertedModelPath === undefined ? undefined : body.convertedModelPath,
      modelFormat: body.modelFormat,
      runnerConfig: shouldPersistRunnerConfig && runnerConfig ? toInputJson(runnerConfig) : undefined,
      defaultWidth: body.defaultWidth,
      defaultHeight: body.defaultHeight,
      allowedOrientations: body.allowedOrientations
        ? toInputJson(body.allowedOrientations)
        : undefined,
      steps: body.steps,
      sampler: body.sampler,
      scheduler: body.scheduler,
      cfgScale: body.cfgScale,
      costMultiplier: body.costMultiplier,
      requiredEntitlement:
        body.requiredEntitlement === undefined ? undefined : body.requiredEntitlement,
      maxCount: body.maxCount,
      concurrencyLimit: body.concurrencyLimit,
      enabled: body.enabled,
      rolloutPercent: body.rolloutPercent,
      dryRunSummary: body.dryRunSummary ? toInputJson(body.dryRunSummary) : undefined,
    },
  });
  await writeAudit(request, actor, {
    action: body.enabled === false ? "generation.profile.disable" : "generation.profile.update",
    targetType: "generation_model_profile",
    targetId: id,
    reason: body.reason,
    before: profileAuditSnapshot(before),
    after: profileAuditSnapshot(updated),
  });
  return ok({ profile: updated });
}

function isOperationalModelProfileDisablePatch(body: z.infer<typeof modelProfilePatchSchema>) {
  if (body.enabled !== false) return false;
  return definedPatchKeys(body).every((key) => ["enabled", "reason", "confirmation"].includes(key));
}

export async function publishModelProfile(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = publishSchema.parse(await jsonBody(request));
  const profile = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!profile) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, profile.id);
  if (profile.status !== "draft") throw Errors.badRequest("Only draft profiles can be published");
  if (profile.mode === "video" && !(await featureEnabled("video_gen"))) {
    throw Errors.forbidden("Video generation is disabled by feature flag");
  }

  const dryRunSummary = body.dryRunSummary
    ? mergeModelProfilePublishEvidence(profile.dryRunSummary, body.dryRunSummary)
    : profile.dryRunSummary;
  if (!dryRunSummary) throw Errors.badRequest("Publish requires dry-run summary");
  assertModelProfilePublishable(profile, dryRunSummary);
  const verifiedSummary = profile.mode === "image"
    ? await attachVerifiedProfileTestEvidence(profile, dryRunSummary)
    : dryRunSummary;

  const previous = await prisma.generationModelProfile.findFirst({
    where: { profileKey: profile.profileKey, status: "active" },
  });
  const published = await prisma.$transaction(async (tx) => {
    await tx.generationModelProfile.updateMany({
      where: { profileKey: profile.profileKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationModelProfile.update({
      where: { id },
      data: {
        status: "active",
        enabled: true,
        rolloutPercent: profile.rolloutPercent > 0 ? profile.rolloutPercent : 100,
        dryRunSummary: verifiedSummary,
        publishedAt: new Date(),
        archivedAt: null,
      },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.profile.publish",
    targetType: "generation_model_profile",
    targetId: id,
    reason: body.reason,
    before: previous ? profileAuditSnapshot(previous) : null,
    after: profileAuditSnapshot(published),
  });
  return ok({ profile: published, previousActiveId: previous?.id ?? null });
}

async function attachVerifiedProfileTestEvidence(
  profile: {
    id: string;
    profileKey: string;
    version: number;
  },
  summaryValue: Prisma.JsonValue | Prisma.InputJsonValue,
): Promise<Prisma.InputJsonValue> {
  const summary = jsonRecord(summaryValue);
  const reviewedSamples = firstNumberFromRecord(summary, [
    "consistencySampleCount",
    "sampleCount",
  ]) ?? 0;
  const evidence = await prisma.generationJob.aggregate({
    where: {
      profileId: { in: [profile.id, profile.profileKey] },
      profileVersion: profile.version,
      sourceType: "admin_profile_test",
      status: "completed",
    },
    _count: { _all: true },
    _sum: { deliveredOutputCount: true },
  });
  const completedOutputs = evidence._sum.deliveredOutputCount ?? 0;
  if (reviewedSamples > completedOutputs) {
    throw Errors.badRequest(
      "Publish requires completed profile-test outputs for every reviewed consistency sample",
      {
        reviewedSamples,
        completedOutputs,
        completedJobs: evidence._count._all,
      },
    );
  }
  return toInputJson({
    ...summary,
    profileTestJobCount: evidence._count._all,
    profileTestOutputCount: completedOutputs,
    profileTestEvidenceVerifiedAt: new Date().toISOString(),
  });
}

function mergeModelProfilePublishEvidence(
  storedSummary: Prisma.JsonValue,
  submittedSummary: Record<string, unknown>,
): Prisma.InputJsonValue {
  const stored = jsonRecord(storedSummary);
  const legacyConsistencySampleCount = numberFromRecord(submittedSummary, "sampleCount");
  const consistencySampleCount =
    numberFromRecord(submittedSummary, "consistencySampleCount") ??
    legacyConsistencySampleCount;
  const consistencyPassCount = numberFromRecord(submittedSummary, "consistencyPassCount");
  const consistencyRate = firstNumberFromRecord(submittedSummary, [
    "consistencyRate",
    "consistencyPassRate",
    "identityConsistencyRate",
    "manualConsistencyRate",
  ]);
  const reviewUrl = stringFromRecord(submittedSummary, "reviewUrl");
  const reviewSource =
    stringFromRecord(submittedSummary, "reviewSource") ??
    stringFromRecord(submittedSummary, "source");
  const reviewStatus =
    stringFromRecord(submittedSummary, "reviewStatus") ??
    stringFromRecord(submittedSummary, "status");

  return toInputJson({
    ...stored,
    ...(consistencySampleCount === undefined ? {} : { consistencySampleCount }),
    ...(consistencyPassCount === undefined ? {} : { consistencyPassCount }),
    ...(consistencyRate === undefined ? {} : { consistencyRate }),
    ...(reviewUrl ? { reviewUrl } : {}),
    ...(reviewSource ? { reviewSource } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
  });
}

function assertModelProfilePublishable(
  profile: {
    mode: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
    runnerConfig: Prisma.JsonValue;
  },
  dryRunSummary: Prisma.JsonValue | Prisma.InputJsonValue,
) {
  const summary = jsonRecord(dryRunSummary);
  const runnerConfig = jsonRecord(profile.runnerConfig);
  const verificationStatus = stringFromRecord(runnerConfig, "verificationStatus");
  if (!verificationStatus && requiresModelVerification(profile, runnerConfig)) {
    throw Errors.badRequest("Publish requires a passed model verification status", {
      verificationStatus: null,
    });
  }
  if (verificationStatus && !["passed", "verified", "manual_passed"].includes(verificationStatus)) {
    throw Errors.badRequest("Publish requires a passed model verification status", {
      verificationStatus,
    });
  }
  const badComponentStatuses = modelProfileBadComponentStatuses(runnerConfig.componentStatus);
  if (badComponentStatuses.length > 0) {
    throw Errors.badRequest("Publish requires all model components to be available", {
      componentStatus: badComponentStatuses,
    });
  }

  const failureMode = stringFromRecord(summary, "failureMode");
  if (failureMode) {
    throw Errors.badRequest("Publish requires a dry run without failureMode", {
      failureMode,
    });
  }

  const sampleCount = profile.mode === "image"
    ? firstNumberFromRecord(summary, ["consistencySampleCount", "sampleCount"])
    : numberFromRecord(summary, "sampleCount");
  const minSamples = profile.mode === "image" ? imageProfilePublishMinSamples : 1;
  if (sampleCount === undefined || sampleCount < minSamples) {
    throw Errors.badRequest(
      profile.mode === "image"
        ? `Publish requires at least ${minSamples} reviewed consistency samples`
        : `Publish requires at least ${minSamples} configuration-check samples`,
      {
      sampleCount,
      minSamples,
      },
    );
  }

  const configurationPassRate = firstNumberFromRecord(summary, [
    "configurationPassRate",
    "successRate",
  ]);
  if (
    configurationPassRate === undefined ||
    configurationPassRate < modelProfilePublishMinRate
  ) {
    throw Errors.badRequest("Publish requires configuration-check pass rate >= 0.8", {
      configurationPassRate: configurationPassRate ?? null,
    });
  }

  if (profile.mode === "image") {
    const consistencyRate = firstNumberFromRecord(summary, [
      "consistencyRate",
      "consistencyPassRate",
      "identityConsistencyRate",
      "manualConsistencyRate",
    ]);
    if (consistencyRate === undefined || consistencyRate < modelProfilePublishMinRate) {
      throw Errors.badRequest("Publish requires image consistencyRate >= 0.8", {
        consistencyRate,
      });
    }
  }
}

function modelProfileBadComponentStatuses(value: unknown) {
  const componentStatus = jsonRecord(value);
  return Object.entries(componentStatus).flatMap(([key, rawValue]) => {
    const status = modelComponentStatusValue(rawValue);
    return status && isBadModelComponentStatus(status) ? [{ key, status }] : [];
  });
}

function modelComponentStatusValue(value: unknown) {
  const rawStatus = typeof value === "string" ? value : isRecord(value) ? stringFromRecord(value, "status") ?? "" : "";
  const status = rawStatus.trim();
  const normalized = status.toLowerCase();
  if (normalized.startsWith("available:")) return "available";
  if (normalized.startsWith("missing:")) return "missing";
  if (normalized.startsWith("failed:")) return "failed";
  if (normalized.startsWith("unsupported:")) return "unsupported";
  return status;
}

function isBadModelComponentStatus(status: string) {
  const normalized = status.toLowerCase();
  return [
    "missing",
    "failed",
    "unsupported",
    "not_imported",
    "required",
    "requires_",
    "unavailable",
  ].some((marker) => normalized.includes(marker));
}

function requiresModelVerification(
  profile: {
    mode: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
  },
  runnerConfig: Record<string, unknown>,
) {
  if (profile.mode !== "image") return false;
  return Boolean(
    profile.sourceModelPath ||
      profile.convertedModelPath ||
      stringFromRecord(runnerConfig, "diffusionModelPath") ||
      stringFromRecord(runnerConfig, "modelPath") ||
      stringFromRecord(runnerConfig, "workflowPath"),
  );
}

export async function rollbackModelProfile(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = rollbackSchema.parse(await jsonBody(request));
  const current = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, current.id);
  const previous = await prisma.generationModelProfile.findFirst({
    where: {
      profileKey: current.profileKey,
      status: "archived",
      version: { lt: current.version },
    },
    orderBy: { version: "desc" },
  });
  if (!previous) throw Errors.notFound("No previous profile version to roll back to");
  const restored = await prisma.$transaction(async (tx) => {
    await tx.generationModelProfile.updateMany({
      where: { profileKey: current.profileKey, status: "active" },
      data: { status: "archived", archivedAt: new Date() },
    });
    return tx.generationModelProfile.update({
      where: { id: previous.id },
      data: { status: "active", enabled: true, publishedAt: new Date(), archivedAt: null },
    });
  });
  await writeAudit(request, actor, {
    action: "generation.profile.rollback",
    targetType: "generation_model_profile",
    targetId: current.id,
    reason: body.reason,
    before: profileAuditSnapshot(current),
    after: profileAuditSnapshot(restored),
  });
  return ok({ profile: restored, fromVersion: current.version, toVersion: restored.version });
}

export async function createProfileTestJob(request: Request, id: string) {
  const actor = await actorWithPermission(request, "generation.config.write");
  const body = modelProfileTestJobSchema.parse(await jsonBody(request));
  const profile = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!profile) throw Errors.notFound("Model profile not found");
  assertTargetConfirmation(body.confirmation, profile.id);
  if (profile.status === "archived") {
    throw Errors.badRequest("Archived profiles cannot create test jobs");
  }
  if (profile.mode !== "image") {
    throw Errors.badRequest("Admin test image currently supports image profiles only");
  }
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = body.orientation ?? allowedOrientations[0] ?? "1:1";
  if (allowedOrientations.length > 0 && !allowedOrientations.includes(orientation)) {
    throw Errors.badRequest("Orientation is not allowed for this profile", {
      orientation,
      allowedOrientations,
    });
  }
  const outputCount = Math.min(body.outputCount, profile.maxCount, 4);
  const controls = profileTestControls(profile, orientation);
  const prompt = body.prompt?.trim() || `Admin test image for ${profile.label}`;
  const negativePrompt = body.negativePrompt?.trim() || null;
  const reservation = await prisma.$transaction(async (tx) => {
    const created = await tx.generationJob.create({
      data: {
        userId: actor.id,
        mode: "image",
        prompt,
        negativePrompt,
        controls: toInputJson(controls),
        presetIds: [],
        model: profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        orientation,
        outputCount,
        status: "queued",
        costDreamcoins: 0,
        provider: profile.runner,
        sourceType: "admin_profile_test",
        sourceId: `${profile.id}:${randomUUID()}`,
        sourceMeta: toInputJson({ profileRecordId: profile.id }),
      },
    });
    await appendAdminGenerationEvent(tx, created.id, "created", "Admin profile test job accepted", {
      profileId: profile.profileKey,
      profileVersion: profile.version,
      source: "admin_generation_config",
    });
    await appendAdminGenerationEvent(tx, created.id, "queued", "Admin profile test job queued", {});
    const dispatch = await reserveInitialGenerationAttempt(tx, {
      requestId: created.id,
      dispatch: {
        outboxId: `generation_initial_${created.id}`,
        eventType: "generation.retry.dispatch.v2",
        payload: { source: "admin_profile_test" },
      },
    });
    return { job: created, outboxId: dispatch.outbox.id };
  });
  const job = reservation.job;

  await dispatchGenerationAttemptOutbox(prisma, {
    outboxIds: [reservation.outboxId],
  });

  await writeAudit(request, actor, {
    action: "generation.profile.test_job",
    targetType: "generation_model_profile",
    targetId: profile.id,
    reason: body.reason,
    after: {
      jobId: job.id,
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      orientation,
      outputCount,
    },
  });
  return ok({ job: redactJob(job) }, { status: 202 });
}

function profileTestControls(
  profile: {
    profileKey: string;
    version: number;
    runner: string;
    pipelineModel: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
    modelFormat: string;
    runnerConfig: Prisma.JsonValue | null;
    steps: number;
    sampler: string;
    scheduler: string;
    cfgScale: number;
    defaultWidth: number;
    defaultHeight: number;
  },
  orientation: string,
) {
  const dimensions = dimensionsForImageOrientation({
    orientation,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
  return pruneUndefined({
    orientation,
    model: profile.profileKey,
    profileId: profile.profileKey,
    width: dimensions.width,
    height: dimensions.height,
    adminTest: true,
  });
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function numberFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function firstNumberFromRecord(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const child = numberFromRecord(value, key);
    if (child !== undefined) return child;
  }
  return undefined;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

async function appendAdminGenerationEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

function profileAuditSnapshot(profile: {
  profileKey: string;
  mode: string;
  runner: string;
  pipelineModel: string;
  sourceModelPath: string | null;
  convertedModelPath: string | null;
  modelFormat: string;
  steps: number;
  sampler: string;
  scheduler: string;
  cfgScale: number;
  costMultiplier: number;
  requiredEntitlement: string | null;
  enabled: boolean;
  rolloutPercent: number;
  version: number;
  status: string;
}) {
  return {
    profileKey: profile.profileKey,
    mode: profile.mode,
    runner: profile.runner,
    pipelineModel: profile.pipelineModel,
    sourceModelPath: profile.sourceModelPath,
    convertedModelPath: profile.convertedModelPath,
    modelFormat: profile.modelFormat,
    steps: profile.steps,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    cfgScale: profile.cfgScale,
    costMultiplier: profile.costMultiplier,
    requiredEntitlement: profile.requiredEntitlement,
    enabled: profile.enabled,
    rolloutPercent: profile.rolloutPercent,
    version: profile.version,
    status: profile.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function definedPatchKeys(value: object) {
  return Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .map(([key]) => key);
}

function adminListCursorKeys(
  url: URL,
  scope: string,
  queryIdentity: unknown,
  parameter = "cursor",
) {
  const raw = url.searchParams.get(parameter);
  if (!raw) return undefined;
  return decodeAdminListCursor(raw, scope, queryIdentity);
}

function adminCursorString(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "string" || !value) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function adminCursorNumber(keys: readonly unknown[], index: number, scope: string) {
  const value = keys[index];
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.badRequest(`${scope} cursor key is invalid`);
  return value;
}

function adminListPageInfo<T>(
  scope: string,
  queryIdentity: unknown,
  page: readonly T[],
  hasNextPage: boolean,
  keys: (row: T) => readonly (string | number | boolean | null)[],
) {
  const last = page.at(-1);
  return {
    endCursor: hasNextPage && last ? encodeAdminListCursor(scope, queryIdentity, keys(last)) : null,
    hasNextPage,
  };
}
