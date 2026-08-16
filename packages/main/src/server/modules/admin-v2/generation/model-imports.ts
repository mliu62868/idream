// SPEC: the local model library an operator imports checkpoints, LoRAs, encoders, and VAEs
//       into, plus the draft profile patch each asset suggests.
// INTENT: migrated from the `model-imports` half of v1 `generation/config/service.ts`. This
//         surface writes to the filesystem, not the database, so it carries no idempotency
//         transport — replaying a register is already the identity one would buy.
// INVARIANT: gated by ADMIN_MODEL_DIAGNOSTICS_ENABLED, asserted after authentication so an
//            unauthenticated caller still gets 401 rather than a 404 that leaks the flag.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  actorWithPermission,
  jsonBody,
  type AdminActor,
} from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { adminRequestId, assertModelDiagnosticsEnabled } from "./model-profiles";

const modelImportKinds = ["model", "lora", "llm", "vae"] as const;
const modelImportKindSchema = z.enum(modelImportKinds);
type ModelImportKind = (typeof modelImportKinds)[number];

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

type ModelImportRegistry = { version: 1; assets: ModelImportRegistryEntry[] };

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

export async function listGenerationModelImports(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  assertModelDiagnosticsEnabled();
  const dirs = modelImportDirs();
  const scannedItems = (
    await Promise.all(modelImportKinds.map((kind) => scanImportDir(kind, dirs[kind])))
  ).flat();
  const registeredItems = await registeredModelImportAssets();
  const items = dedupeModelImportAssets([...scannedItems, ...registeredItems]);
  return {
    roots: dirs,
    maxUploadBytes: modelUploadMaxBytes(),
    items: items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
  };
}

export async function registerGenerationModelImport(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  assertModelDiagnosticsEnabled();
  const body = await jsonBody(request, "generationModelImportRegisterRequestSchema");
  const { assets, sourceType, resolvedPath } = await modelImportAssetsFromPath(body.kind, body.path);
  await upsertModelImportRegistryEntries(assets);
  await writeImportAudit(request, actor, {
    action: sourceType === "directory"
      ? "generation.model_import.register_directory"
      : "generation.model_import.register",
    targetType: sourceType === "directory"
      ? `generation_${body.kind}_asset_directory`
      : `generation_${body.kind}_asset`,
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
  return { asset: assets[0]!, assets, roots: modelImportDirs() };
}

export async function uploadGenerationModelImport(request: Request) {
  const actor = await actorWithPermission(request, "generation.config.write");
  assertModelDiagnosticsEnabled();
  // multipart/form-data has no JSON body for the manifest to narrow, so the manifest declares
  // `none` and the only field that decides anything is validated right here.
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

  await writeImportAudit(request, actor, {
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
  return { asset, roots: modelImportDirs() };
}

async function writeImportAudit(
  request: Request,
  actor: AdminActor,
  input: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason?: string;
    readonly after: unknown;
  },
) {
  await prisma.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      after: toInputJson(input.after),
      requestId: adminRequestId(request),
    },
  });
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

async function upsertModelImportRegistryEntries(assets: readonly ModelImportAsset[]) {
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

function dedupeModelImportAssets(items: readonly ModelImportAsset[]) {
  const byKey = new Map<string, ModelImportAsset>();
  for (const item of items) byKey.set(`${item.kind}:${item.path}`, item);
  return Array.from(byKey.values());
}

function dedupeRegistryEntries(entries: readonly ModelImportRegistryEntry[]) {
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

async function scanImportDir(
  kind: ModelImportKind,
  dir: string,
  depth = 0,
): Promise<ModelImportAsset[]> {
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
  return { sourceType: "directory" as const, resolvedPath, assets };
}

async function modelImportAsset(
  kind: ModelImportKind,
  filePath: string,
  sizeBytes: number,
  modifiedAt: Date,
): Promise<ModelImportAsset> {
  const format = modelFormatFromPath(filePath);
  const metadataText = format === "safetensors" ? await readSafetensorsMetadataText(filePath) : "";
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

  if (isComfyuiFp8Krea2ModelImport(slug, filePath, metadataText)) {
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
  // INTENT: an unrecognized checkpoint drafts as a plain ComfyUI profile. The old fallback
  // drafted an sd.cpp profile carrying a GGUF conversion step; that runner is retired, so the
  // draft would have described a profile nothing can execute.
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
    return Object.entries(metadata)
      .map(([key, value]) => `${key}:${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n")
      .slice(0, 80_000);
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
    const candidate = attempt === 0
      ? path.join(dir, name)
      : path.join(dir, `${base}-${randomUUID().slice(0, 8)}${ext}`);
    const exists = await stat(candidate).then(() => true, () => false);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
