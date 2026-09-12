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
import { prepareComfyUiRunnerMemory } from "./backend/comfyui-memory-transition";
import { buildBackendRegistry, type BackendRegistry } from "./backend/registry";
import { withGenerationAcceleratorLease } from "./backend/generation-accelerator-lease";
import { env } from "./env";
import type { GenAdapter } from "./provider-vocabulary";

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

export type GenerationInvocationBoundary = {
  onResourceWait: () => Promise<void>;
  beforeProviderInvocation: () => Promise<void>;
};

export interface ImageModel {
  readonly retryCapabilities?: ProviderRetryCapabilities;
  readonly managesInvocationBoundary?: true;
  generate(input: {
    executionBoundary?: GenerationInvocationBoundary;
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
  readonly managesInvocationBoundary?: true;
  generate(input: {
    executionBoundary?: GenerationInvocationBoundary;
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
// backend instances (ComfyUIBackend/DrawThingsBackend) — do this once and cache
// the in-flight/resolved Promise at module scope, since buildImageModel() (and
// thus buildBackendImageModel()) runs on every `providers.image` access.
let registryPromise: Promise<BackendRegistry> | undefined;

function getBackendRegistry(): Promise<BackendRegistry> {
  registryPromise ??= buildBackendRegistry({
    comfyImageApiUrl: env.COMFYUI_IMAGE_API_URL,
    comfyVideoApiUrl: env.COMFYUI_VIDEO_API_URL,
    comfyH3ApiUrl: env.COMFYUI_H3_API_URL,
    drawThingsCli: env.DRAWTHINGS_CLI,
    drawThingsModelsDir: env.DRAWTHINGS_MODELS_DIR,
    drawThingsOffline: env.DRAWTHINGS_OFFLINE,
    workflowDir: env.GEN_WORKFLOW_DIR,
  });
  return registryPromise;
}

function buildBackendImageModel(): ImageModel {
  return new BackendImageModel(
    getBackendRegistry(),
    (run, options) => withGenerationAcceleratorLease("image", run, options),
    prepareComfyUiRunnerMemory,
  );
}

function buildImageModel(): ImageModel {
  assertProductionProviderReady("image");
  switch (env.IMAGE_PROVIDER) {
    case "mock":
      return new MockImageModel();
    case "backend":
      return buildBackendImageModel();
  }
}

function buildVideoModel(): VideoModel {
  assertProductionProviderReady("video");
  switch (env.VIDEO_PROVIDER) {
    case "mock":
      return new MockVideoModel();
    case "backend":
      return new BackendVideoModel(
        getBackendRegistry(),
        (run, options) => withGenerationAcceleratorLease("video", run, options),
        prepareComfyUiRunnerMemory,
      );
  }
}

function buildBlobStore(): BlobStore {
  assertProductionBlobReady();
  switch (env.BLOB_PROVIDER) {
    case "mock":
      return new MockBlobStore();
    case "r2":
    case "s3":
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

// SPEC: adapters each mode is allowed to run under APP_ENV=production.
// INTENT: both modes are backend-only. Image used to also admit `pipeline`, the
// legacy OpenAI-compatible gateway, on the grounds that it was the documented
// production rollback — but the runbook that claim pointed at does not exist
// (docs/architecture/10-operations.md has no pipeline rollback), both
// architecture documents already called the adapter deprecated, and it had zero
// callers. Keeping a rollback nobody could execute only widened what production
// was allowed to run. Video was backend-only all along because its production
// routes are RedGraft LTX 2.5 and MiniMax H3, and only BackendVideoModel
// enforces each pinned runtime envelope plus ffprobe/ffmpeg-verified decode.
const PRODUCTION_ADAPTERS: Record<"image" | "video", readonly GenAdapter[]> = {
  image: ["backend"],
  video: ["backend"],
};

export function assertProductionProviderReady(kind: "image" | "video") {
  const provider = kind === "image" ? env.IMAGE_PROVIDER : env.VIDEO_PROVIDER;
  if (kind === "video") {
    // Startup authority: a malformed long-job budget must crash the worker
    // before it accepts its first paid request.
    void env.VIDEO_TIMEOUT_MS;
  }
  // 词表检查已经由 env getter 的解析完成 —— 读到 `provider` 这一行就意味着它
  // 是 GenAdapter 的成员，此处只剩"生产环境允许哪几个"这条**策略**。
  if (env.APP_ENV !== "production") return;

  if (provider === "mock") {
    throw new Error(`Production ${kind} generation requires a non-mock provider`);
  }

  if (!PRODUCTION_ADAPTERS[kind].includes(provider)) {
    throw new Error(
      `Production ${kind} generation requires GEN_${kind.toUpperCase()}_PROVIDER=${PRODUCTION_ADAPTERS[kind].join(" or ")}`,
    );
  }

  const comfyUiApiUrl = kind === "image"
    ? env.COMFYUI_IMAGE_API_URL
    : env.COMFYUI_VIDEO_API_URL;
  if (provider === "backend" && !comfyUiApiUrl) {
    throw new Error(
      `Production ${kind} generation requires COMFYUI_${kind.toUpperCase()}_API_URL`,
    );
  }
}

export function assertProductionModerationReady() {
  if (env.APP_ENV !== "production") return;

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
  if (env.APP_ENV !== "production") return;

  if (env.BLOB_PROVIDER === "mock") {
    throw new Error("Production generation requires a non-mock blob provider");
  }
  // 词表之外的值在 env getter 上就抛了，这里剩下的只可能是 r2/s3。
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









