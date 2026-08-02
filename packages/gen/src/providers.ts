// SPEC: Self-contained provider mocks for the generation service — image model,
// video model, and a private blob store. Ported from packages/main providers,
// stripped of Next/Prisma. gen is the slow async tier: generate → write blob.
// INTENT: Keep the exact result-envelope shape (ProviderResult) main uses so the
// pipeline logic ports 1:1.
// INVARIANTS: blob.putPrivate is the ONLY persistence gen performs. No DB.
import { Buffer } from "node:buffer";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import type { VideoGeneratePayload } from "@idream/shared/contracts";
import {
  mockVideoMp4Bytes,
  S3CompatibleBlobStore,
  SafetyGatewayModerationProvider,
} from "@idream/shared";
import { BackendImageModel } from "./backend/backend-image-model";
import { BackendVideoModel } from "./backend/backend-video-model";
import { buildBackendRegistry, type BackendRegistry } from "./backend/registry";
import { env } from "./env";

export interface ProviderFailure {
  code: string;
  message: string;
  retryable: boolean;
  /**
   * SPEC: ambiguous means the remote request may have been accepted and must
   * not be replayed without provider idempotency. Omitted preserves the legacy
   * code/retryable classification for non-backend adapters.
   */
  outcome?: "definitive" | "ambiguous";
}

export interface ProviderInvocationMetadata {
  providerRequestId: string | null;
  usage: Readonly<Record<string, unknown>>;
  costMicros: number | null;
  pricingVersion: string | null;
}

export type ProviderResult<T> =
  | { ok: true; data: T; invocation?: ProviderInvocationMetadata }
  | { ok: false; error: ProviderFailure; invocation?: ProviderInvocationMetadata };

export interface ProviderRetryCapabilities {
  readonly deterministicIdempotencyKey: boolean;
  readonly retryableFailureCodes: readonly string[];
}

const retryablePipelineCategories = new Set(["rate_limited", "overloaded", "timeout", "internal"]);

export interface ImageModel {
  readonly retryCapabilities?: ProviderRetryCapabilities;
  generate(input: {
    prompt: string;
    count: number;
    seed?: string;
    negativePrompt?: string | null;
    model?: string;
    controls?: Record<string, unknown>;
    requestId?: string;
    orientation?: string;
    referenceImages?: NonNullable<ImageGeneratePayload["referenceImages"]>;
  }): Promise<
    ProviderResult<{
      assets: Array<{
        key?: string;
        width: number;
        height: number;
        contentType?: string;
        body?: Uint8Array;
        sourceUrl?: string;
      }>;
    }>
  >;
}

export interface VideoModel {
  readonly retryCapabilities?: ProviderRetryCapabilities;
  generate(input: {
    prompt: string;
    seconds: number;
    seed?: string;
    negativePrompt?: string | null;
    model?: string;
    controls?: Record<string, unknown>;
    requestId?: string;
    referenceImages?: NonNullable<VideoGeneratePayload["referenceImages"]>;
  }): Promise<
    ProviderResult<{
      asset: {
        key?: string;
        seconds: number;
        contentType?: string;
        body?: Uint8Array;
        sourceUrl?: string;
      };
    }>
  >;
}

export interface ModerationProvider {
  check(input: {
    targetType: "text" | "image" | "video";
    content: string;
  }): Promise<
    ProviderResult<{
      status: "passed" | "flagged" | "blocked";
      policyCode?: string;
      confidence: number;
    }>
  >;
}

export interface BlobStore {
  putPrivate(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<ProviderResult<{ key: string; size: number }>>;
  putPrivateIfAbsent(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<ProviderResult<{ key: string; size: number; created: boolean }>>;
  delete(input: { key: string }): Promise<ProviderResult<{ deleted: true }>>;
  signGetUrl(input: { key: string; expiresInSeconds: number }): Promise<ProviderResult<{ url: string }>>;
  getPrivate?(input: { key: string }): Promise<ProviderResult<{ body: Uint8Array; contentType: string | null }>>;
}

class MockImageModel implements ImageModel {
  readonly retryCapabilities = { deterministicIdempotencyKey: true, retryableFailureCodes: [...retryablePipelineCategories] } as const;
  async generate(input: Parameters<ImageModel["generate"]>[0]) {
    const count = Math.max(1, Math.min(input.count, 4));
    const seed = input.seed ?? "mock";
    return {
      ok: true as const,
      data: {
        assets: Array.from({ length: count }, (_, index) => ({
          key: `mock/images/${seed}-${index + 1}.png`,
          width: 1024,
          height: 1024,
          contentType: "image/png",
          body: mockImagePngBytes(16, 16),
        })),
      },
    };
  }
}

function mockImagePngBytes(width: number, height: number) {
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      row[offset] = (x * 67 + y * 19) % 256;
      row[offset + 1] = (x * 29 + y * 83) % 256;
      row[offset + 2] = (x * 11 + y * 47) % 256;
    }
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mockPngChunk("IHDR", ihdr),
    mockPngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    mockPngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function mockPngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(mockPngCrc32(chunk), 0);
  return Buffer.concat([length, chunk, crc]);
}

const mockPngCrcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function mockPngCrc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = mockPngCrcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class MockVideoModel implements VideoModel {
  readonly retryCapabilities = { deterministicIdempotencyKey: true, retryableFailureCodes: [...retryablePipelineCategories] } as const;
  async generate(input: Parameters<VideoModel["generate"]>[0]) {
    return {
      ok: true as const,
      data: {
        asset: {
          key: `mock/videos/${input.seed ?? "mock"}.mp4`,
          seconds: input.seconds,
          contentType: "video/mp4",
          body: mockVideoMp4Bytes(),
        },
      },
    };
  }
}

const blockedTerms = ["underage", "minor", "csam"];

class MockModerationProvider implements ModerationProvider {
  async check(input: Parameters<ModerationProvider["check"]>[0]) {
    const lowered = input.content.toLowerCase();
    const blockedTerm = blockedTerms.find((term) => lowered.includes(term));
    if (blockedTerm) {
      return {
        ok: true as const,
        data: {
          status: "blocked" as const,
          // Distinct codes preserve the audit distinction (matches chat moderation):
          // csam → potential_underage_content; underage/minor → age_under_18.
          policyCode: blockedTerm === "csam" ? "potential_underage_content" : "age_under_18",
          confidence: 0.99,
        },
      };
    }
    return {
      ok: true as const,
      data: { status: "passed" as const, confidence: 0.5 },
    };
  }
}

const pipelineResponseSchema = {
  parse(value: unknown, requestedCount: number) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Pipeline response must be an object");
    }
    const record = value as Record<string, unknown>;
    const rawAssets = Array.isArray(record.assets)
      ? record.assets
      : Array.isArray(record.data)
        ? record.data
        : undefined;
    if (!rawAssets?.length) {
      throw new Error("Pipeline response did not include any assets");
    }

    const limit = Math.max(1, Math.min(requestedCount, 4));
    const assets = rawAssets.slice(0, limit).map((item, index) => {
      if (typeof item !== "object" || item === null) {
        throw new Error(`Pipeline asset ${index + 1} must be an object`);
      }
      const recordItem = item as Record<string, unknown>;
      const body =
        typeof recordItem.b64_json === "string"
          ? new Uint8Array(Buffer.from(recordItem.b64_json, "base64"))
          : typeof recordItem.base64 === "string"
            ? new Uint8Array(Buffer.from(recordItem.base64, "base64"))
            : undefined;
      const sourceUrl = typeof recordItem.url === "string" ? recordItem.url : undefined;
      if (!body && !sourceUrl) {
        throw new Error(`Pipeline asset ${index + 1} is missing image bytes or URL`);
      }
      return {
        key: typeof recordItem.key === "string" ? recordItem.key : `pipeline/asset-${index + 1}`,
        width: typeof recordItem.width === "number" ? recordItem.width : 1024,
        height: typeof recordItem.height === "number" ? recordItem.height : 1024,
        contentType: imageContentType(recordItem, body),
        body,
        sourceUrl,
      };
    });
    return { assets };
  },
};

class PipelineImageModel implements ImageModel {
  // INTENT: requestId is correlation only. The legacy gateway has no durable
  // same-key result contract, so a timeout must become unknown, never Bull retry.
  async generate(input: Parameters<ImageModel["generate"]>[0]) {
    const endpoint = pipelineEndpoint("/images/generations");
    if (!endpoint) {
      return {
        ok: false as const,
        error: {
          code: "invalid_params",
          message: "PIPELINE_API_URL is required for pipeline image provider",
          retryable: false,
        },
      };
    }

    const count = Math.max(1, Math.min(input.count, 4));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.PIPELINE_TIMEOUT_MS);
    const referenceImages = pipelineReferenceImages(input.referenceImages);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.PIPELINE_API_TOKEN
            ? { authorization: `Bearer ${env.PIPELINE_API_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          requestId: input.requestId,
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          negative_prompt: input.negativePrompt,
          model: input.model ?? env.PIPELINE_IMAGE_MODEL_DEFAULT,
          profileId: input.controls?.profileId ?? env.PIPELINE_PROFILE_DEFAULT,
          orientation: input.orientation,
          size: imageSize(input.controls, input.orientation),
          count,
          n: count,
          response_format: "b64_json",
          seed: stableNumericSeed(input.seed),
          ...(referenceImages.length > 0 ? { reference_images: referenceImages } : {}),
          controls: { ...(input.controls ?? {}), idreamSeed: input.seed },
        }),
        signal: controller.signal,
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) return pipelineFailure(json, response.status);
      const parsed = pipelineResponseSchema.parse(json, count);
      return { ok: true as const, data: parsed, invocation: pipelineInvocationMetadata(json) };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false as const,
        error: {
          code: aborted ? "timeout" : "internal",
          message: aborted
            ? "Pipeline request timed out"
            : error instanceof Error
              ? error.message
              : "Pipeline request failed",
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function pipelineReferenceImages(
  images: Parameters<ImageModel["generate"]>[0]["referenceImages"],
) {
  return (images ?? []).map((image) => {
    const reference: Record<string, unknown> = {
      role: image.role,
      assetId: image.assetId,
      asset_id: image.assetId,
      weight: image.weight,
      contentType: image.contentType,
      content_type: image.contentType,
      width: image.width,
      height: image.height,
      storageKey: image.storageKey,
      storage_key: image.storageKey,
      url: image.url,
      b64_json: image.b64Json,
    };
    for (const key of Object.keys(reference)) {
      if (reference[key] === undefined || reference[key] === null || reference[key] === "") {
        delete reference[key];
      }
    }
    return reference;
  });
}

const pipelineVideoResponseSchema = {
  parse(value: unknown, input: Parameters<VideoModel["generate"]>[0]) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Pipeline response must be an object");
    }
    const record = value as Record<string, unknown>;
    const rawAsset = firstVideoAsset(record);
    if (!rawAsset) {
      throw new Error("Pipeline response did not include a video asset");
    }

    const body =
      typeof rawAsset.b64_json === "string"
        ? new Uint8Array(Buffer.from(rawAsset.b64_json, "base64"))
        : typeof rawAsset.base64 === "string"
          ? new Uint8Array(Buffer.from(rawAsset.base64, "base64"))
          : undefined;
    const sourceUrl = typeof rawAsset.url === "string" ? rawAsset.url : undefined;
    if (!body && !sourceUrl) {
      throw new Error("Pipeline video asset is missing video bytes or URL");
    }

    return {
      asset: {
        key:
          typeof rawAsset.key === "string"
            ? rawAsset.key
            : `pipeline/videos/${input.requestId ?? "video"}.mp4`,
        seconds:
          numberField(rawAsset, "seconds") ??
          numberField(rawAsset, "duration") ??
          numberField(rawAsset, "duration_seconds") ??
          input.seconds,
        contentType:
          typeof rawAsset.contentType === "string"
            ? rawAsset.contentType
            : typeof rawAsset.mime_type === "string"
              ? rawAsset.mime_type
              : "video/mp4",
        body,
        sourceUrl,
      },
    };
  },
};

class PipelineVideoModel implements VideoModel {
  // INTENT: keep this rollback adapter non-replayable until its gateway proves
  // concurrent and post-restart same-key result reuse with payload conflicts.
  async generate(input: Parameters<VideoModel["generate"]>[0]) {
    const endpoint = pipelineEndpoint("/videos/generations");
    if (!endpoint) {
      return {
        ok: false as const,
        error: {
          code: "invalid_params",
          message: "PIPELINE_API_URL is required for pipeline video provider",
          retryable: false,
        },
      };
    }

    const seconds = Math.max(1, Math.min(input.seconds, 30));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.PIPELINE_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.PIPELINE_API_TOKEN
            ? { authorization: `Bearer ${env.PIPELINE_API_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          requestId: input.requestId,
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          negative_prompt: input.negativePrompt,
          model: input.model ?? env.PIPELINE_VIDEO_MODEL_DEFAULT,
          seconds,
          duration: seconds,
          response_format: "url",
          seed: stableNumericSeed(input.seed),
          controls: { ...(input.controls ?? {}), idreamSeed: input.seed },
        }),
        signal: controller.signal,
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) return pipelineFailure(json, response.status);
      const parsed = pipelineVideoResponseSchema.parse(json, input);
      return { ok: true as const, data: parsed, invocation: pipelineInvocationMetadata(json) };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false as const,
        error: {
          code: aborted ? "timeout" : "internal",
          message: aborted
            ? "Pipeline request timed out"
            : error instanceof Error
              ? error.message
              : "Pipeline request failed",
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// SPEC: Mock blob store. Persists bytes under BLOB_ROOT (real fs write so the
// "gen writes the blob" boundary is actually exercised), keyed by the asset key.
class MockBlobStore implements BlobStore {
  async putPrivate(input: Parameters<BlobStore["putPrivate"]>[0]) {
    const target = path.join(env.BLOB_ROOT, input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return {
      ok: true as const,
      data: { key: input.key, size: input.body.byteLength },
    };
  }

  async putPrivateIfAbsent(
    input: Parameters<BlobStore["putPrivateIfAbsent"]>[0],
  ) {
    const target = path.join(env.BLOB_ROOT, input.key);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, input.body, { flag: "wx" });
      return {
        ok: true as const,
        data: {
          key: input.key,
          size: input.body.byteLength,
          created: true,
        },
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code === "EEXIST") {
        return {
          ok: true as const,
          data: {
            key: input.key,
            size: input.body.byteLength,
            created: false,
          },
        };
      }
      return {
        ok: false as const,
        error: {
          code: "put_if_absent_failed",
          message: error instanceof Error ? error.message : "blob write failed",
          retryable: true,
        },
      };
    }
  }

  async signGetUrl(input: Parameters<BlobStore["signGetUrl"]>[0]) {
    return {
      ok: true as const,
      data: {
        url: `https://mock-blob.idream.local/${encodeURIComponent(input.key)}?ttl=${input.expiresInSeconds}`,
      },
    };
  }

  async delete(input: Parameters<BlobStore["delete"]>[0]) {
    try {
      await unlink(path.join(env.BLOB_ROOT, input.key));
      return { ok: true as const, data: { deleted: true as const } };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code === "ENOENT") {
        return { ok: true as const, data: { deleted: true as const } };
      }
      return {
        ok: false as const,
        error: {
          code: "delete_failed",
          message: error instanceof Error ? error.message : "blob delete failed",
          retryable: true,
        },
      };
    }
  }

  async getPrivate(input: { key: string }) {
    try {
      return {
        ok: true as const,
        data: { body: new Uint8Array(await readFile(path.join(env.BLOB_ROOT, input.key))), contentType: "application/json" },
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      return {
        ok: false as const,
        error: {
          code: code === "ENOENT" ? "not_found" : "get_failed",
          message: error instanceof Error ? error.message : "blob read failed",
          retryable: code !== "ENOENT",
        },
      };
    }
  }
}

// SPEC: the registry loads workflow descriptors from disk and constructs the
// backend instances (ComfyUIBackend/SdcppBackend) — do this once and cache the
// in-flight/resolved Promise at module scope, since buildImageModel() (and thus
// buildBackendImageModel()) runs on every `providers.image` access.
let registryPromise: Promise<BackendRegistry> | undefined;

function getBackendRegistry(): Promise<BackendRegistry> {
  registryPromise ??= buildBackendRegistry({
    comfyApiUrl: env.COMFYUI_API_URL,
    sdcppCli: env.SDCPP_CLI,
    drawThingsCli: env.DRAWTHINGS_CLI,
    drawThingsModelsDir: env.DRAWTHINGS_MODELS_DIR,
    drawThingsOffline: env.DRAWTHINGS_OFFLINE,
    workflowDir: env.GEN_WORKFLOW_DIR,
  });
  return registryPromise;
}

function buildBackendImageModel(): ImageModel {
  return new BackendImageModel(getBackendRegistry());
}

function buildImageModel(): ImageModel {
  assertProductionProviderReady("image");
  if (env.IMAGE_PROVIDER === "mock") return new MockImageModel();
  if (env.IMAGE_PROVIDER === "backend") return buildBackendImageModel();
  // deprecated: external OpenAI-compatible gateway (self-hosted models behind a
  // separate pipeline service). GEN_IMAGE_PROVIDER=backend talks to ComfyUI/sd-cli
  // directly via the workflow-native GenBackend abstraction instead.
  if (env.IMAGE_PROVIDER === "pipeline") return new PipelineImageModel();
  throw new Error(`Unsupported image provider: ${env.IMAGE_PROVIDER}`);
}

function buildVideoModel(): VideoModel {
  assertProductionProviderReady("video");
  if (env.VIDEO_PROVIDER === "mock") return new MockVideoModel();
  if (env.VIDEO_PROVIDER === "backend") {
    return new BackendVideoModel(getBackendRegistry());
  }
  if (env.VIDEO_PROVIDER === "pipeline") return new PipelineVideoModel();
  throw new Error(`Unsupported video provider: ${env.VIDEO_PROVIDER}`);
}

function buildBlobStore(): BlobStore {
  assertProductionBlobReady();
  if (env.BLOB_PROVIDER === "mock") return new MockBlobStore();
  if (env.BLOB_PROVIDER === "r2" || env.BLOB_PROVIDER === "s3") {
    return new S3CompatibleBlobStore({
      endpoint: requireBlobEnv("BLOB_ENDPOINT", env.BLOB_ENDPOINT),
      bucket: requireBlobEnv("BLOB_BUCKET", env.BLOB_BUCKET),
      region: env.BLOB_REGION,
      accessKeyId: requireBlobEnv("BLOB_ACCESS_KEY_ID", env.BLOB_ACCESS_KEY_ID),
      secretAccessKey: requireBlobEnv(
        "BLOB_SECRET_ACCESS_KEY",
        env.BLOB_SECRET_ACCESS_KEY,
      ),
    });
  }
  throw new Error(`Unsupported blob provider: ${env.BLOB_PROVIDER}`);
}

function buildModerationProvider(): ModerationProvider {
  assertProductionModerationReady();
  if (env.MODERATION_PROVIDER === "mock") return new MockModerationProvider();
  if (env.MODERATION_PROVIDER === "safety-gateway") {
    return new SafetyGatewayModerationProvider({
      serviceUrl: requireProviderEnv(
        "MODERATION_SERVICE_URL",
        env.MODERATION_SERVICE_URL,
        "MODERATION_PROVIDER",
        env.MODERATION_PROVIDER,
      ),
      apiKey: requireProviderEnv(
        "MODERATION_API_KEY",
        env.MODERATION_API_KEY,
        "MODERATION_PROVIDER",
        env.MODERATION_PROVIDER,
      ),
      timeoutMs: env.MODERATION_TIMEOUT_MS,
    });
  }
  throw new Error(`Unsupported moderation provider: ${env.MODERATION_PROVIDER}`);
}

export function assertProductionProviderReady(kind: "image" | "video") {
  const provider = kind === "image" ? env.IMAGE_PROVIDER : env.VIDEO_PROVIDER;
  if (kind === "video") {
    // Startup authority: a malformed long-job budget must crash the worker
    // before it accepts its first paid request.
    void env.VIDEO_TIMEOUT_MS;
  }
  const supported = ["mock", "pipeline", "backend"];
  if (!supported.includes(provider)) {
    throw new Error(`Unsupported ${kind} provider: ${provider}`);
  }
  if (process.env.APP_ENV !== "production") return;

  if (kind === "video" && provider !== "backend") {
    throw new Error(
      "Production video generation requires GEN_VIDEO_PROVIDER=backend",
    );
  }

  if (provider === "mock") {
    throw new Error(`Production ${kind} generation requires a non-mock provider`);
  }

  if (provider === "pipeline" && !env.PIPELINE_API_URL) {
    throw new Error(`Production ${kind} generation requires PIPELINE_API_URL`);
  }

  if (provider === "backend" && !env.COMFYUI_API_URL) {
    throw new Error(`Production ${kind} generation requires COMFYUI_API_URL`);
  }
}

export function assertProductionModerationReady() {
  if (process.env.APP_ENV !== "production") return;

  if (env.MODERATION_PROVIDER === "safety-gateway") {
    requireProviderEnv(
      "MODERATION_SERVICE_URL",
      env.MODERATION_SERVICE_URL,
      "MODERATION_PROVIDER",
      env.MODERATION_PROVIDER,
    );
    requireProviderEnv(
      "MODERATION_API_KEY",
      env.MODERATION_API_KEY,
      "MODERATION_PROVIDER",
      env.MODERATION_PROVIDER,
    );
  }
}

export function assertProductionBlobReady() {
  if (process.env.APP_ENV !== "production") return;

  if (env.BLOB_PROVIDER === "mock") {
    throw new Error("Production generation requires a non-mock blob provider");
  }
  if (env.BLOB_PROVIDER !== "r2" && env.BLOB_PROVIDER !== "s3") {
    throw new Error(`Unsupported blob provider: ${env.BLOB_PROVIDER}`);
  }
  requireBlobEnv("BLOB_ENDPOINT", env.BLOB_ENDPOINT);
  requireBlobEnv("BLOB_BUCKET", env.BLOB_BUCKET);
  requireBlobEnv("BLOB_ACCESS_KEY_ID", env.BLOB_ACCESS_KEY_ID);
  requireBlobEnv("BLOB_SECRET_ACCESS_KEY", env.BLOB_SECRET_ACCESS_KEY);
}

function requireBlobEnv(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required when BLOB_PROVIDER=${env.BLOB_PROVIDER}`);
  return value;
}

function requireProviderEnv(
  name: string,
  value: string | undefined,
  providerName: string,
  provider: string,
) {
  if (!value) throw new Error(`${name} is required when ${providerName}=${provider}`);
  return value;
}

export interface GenProviders {
  image: ImageModel;
  video: VideoModel;
  moderation: ModerationProvider;
  blob: BlobStore;
}

// INTENT: Main integration tests exercise the real Gen pipeline without
// reintroducing image/video execution adapters into Main. Stable instances let
// tests inject provider failures and inspect calls through the Gen-owned seam.
export function createMockGenProviders(): GenProviders {
  return {
    image: new MockImageModel(),
    video: new MockVideoModel(),
    moderation: new MockModerationProvider(),
    blob: new MockBlobStore(),
  };
}

export const providers: GenProviders = {
  get image() {
    return buildImageModel();
  },
  get video() {
    return buildVideoModel();
  },
  get moderation() {
    return buildModerationProvider();
  },
  get blob() {
    return buildBlobStore();
  },
};

function pipelineEndpoint(defaultPath: string) {
  if (!env.PIPELINE_API_URL) return undefined;
  const url = new URL(env.PIPELINE_API_URL);
  if (url.pathname !== "/" && url.pathname !== "") return url;
  return new URL(defaultPath, url);
}

function imageContentType(record: Record<string, unknown>, body: Uint8Array | undefined) {
  if (typeof record.contentType === "string") return record.contentType;
  if (typeof record.mime_type === "string") return record.mime_type;
  if (!body) return "image/webp";
  if (hasSignature(body, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (hasSignature(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    body.byteLength >= 12 &&
    asciiEquals(body, 0, "RIFF") &&
    asciiEquals(body, 8, "WEBP")
  ) {
    return "image/webp";
  }
  return "image/png";
}

function hasSignature(body: Uint8Array, signature: number[]) {
  if (body.byteLength < signature.length) return false;
  return signature.every((byte, index) => body[index] === byte);
}

function asciiEquals(body: Uint8Array, offset: number, expected: string) {
  if (body.byteLength < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (body[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

// Exported so BackendImageModel (backend/backend-image-model.ts) can reuse the same
// FNV hashing for non-numeric wire seeds instead of duplicating it — see that file's
// numericSeed() for the wire-contract rationale (job.seed is usually a non-numeric id).
export function stableNumericSeed(seed: string | undefined) {
  if (!seed) return undefined;
  const numeric = Number.parseInt(seed, 10);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;

  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function imageSize(controls: Record<string, unknown> | undefined, orientation: string | undefined) {
  const explicit = stringControl(controls, "size");
  if (explicit) return explicit;

  const width = numericControl(controls, "width");
  const height = numericControl(controls, "height");
  if (width && height) return `${width}x${height}`;

  return env.PIPELINE_IMAGE_SIZE_DEFAULT ?? orientationToOpenAiSize(orientation);
}

function stringControl(controls: Record<string, unknown> | undefined, key: string) {
  const value = controls?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericControl(controls: Record<string, unknown> | undefined, key: string) {
  const value = controls?.[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function firstVideoAsset(record: Record<string, unknown>) {
  const direct = record.asset;
  if (typeof direct === "object" && direct !== null && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  if (
    typeof record.url === "string" ||
    typeof record.b64_json === "string" ||
    typeof record.base64 === "string"
  ) {
    return record;
  }
  const rawAssets = Array.isArray(record.assets)
    ? record.assets
    : Array.isArray(record.data)
      ? record.data
      : undefined;
  const first = rawAssets?.[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function orientationToOpenAiSize(orientation: string | undefined) {
  switch (orientation) {
    case "4:5":
    case "portrait":
      return "1024x1280";
    case "3:4":
      return "1024x1365";
    case "9:16":
      return "1024x1792";
    case "16:9":
    case "landscape":
      return "1792x1024";
    case "1:1":
    case "square":
    default:
      return "1024x1024";
  }
}

function pipelineFailure(value: unknown, status: number): ProviderResult<never> {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : record;
  const rawCategory = nested.category ?? nested.code;
  const category = typeof rawCategory === "string" ? rawCategory : statusToCategory(status);
  const rawMessage = nested.message;
  const message = typeof rawMessage === "string" ? rawMessage : "Pipeline image generation failed";
  return {
    ok: false,
    error: {
      code: category,
      message,
      retryable: retryablePipelineCategories.has(category),
    },
    invocation: pipelineInvocationMetadata(record),
  };
}

function pipelineInvocationMetadata(value: unknown): ProviderInvocationMetadata {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const usage = typeof record.usage === "object" && record.usage !== null && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : {};
  const rawCost = record.costMicros ?? record.cost_micros;
  const rawPricingVersion = record.pricingVersion ?? record.pricing_version;
  const pricingVersion = typeof rawPricingVersion === "string" && rawPricingVersion.trim().length > 0
    ? rawPricingVersion.trim()
    : null;
  const costMicros = pricingVersion !== null && typeof rawCost === "number" && Number.isSafeInteger(rawCost) && rawCost >= 0
    ? rawCost
    : null;
  const rawProviderRequestId = record.providerRequestId ?? record.provider_request_id ?? record.id;
  return {
    providerRequestId: typeof rawProviderRequestId === "string" && rawProviderRequestId.length > 0
      ? rawProviderRequestId
      : null,
    usage,
    costMicros,
    pricingVersion,
  };
}

function statusToCategory(status: number) {
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "internal";
  return "invalid_params";
}
