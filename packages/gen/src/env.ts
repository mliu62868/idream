// SPEC: Generation service runtime config. One typed accessor; no scattered
// process.env reads. gen is a pure async worker — needs only Redis (for the
// BullMQ queues) and a blob root (mock blob store writes under it).
// INTENT: Lazy getters so importing this module never throws; tests can run
// without any env set. Config comes from packages/gen/.env (see .env.example),
// loaded here non-overriding so injected vars still win.
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import {
  BLOB_ACCESS_KEY_ID_ALIASES,
  BLOB_SECRET_ACCESS_KEY_ALIASES,
  DEFAULT_APP_ENV,
  DEFAULT_BLOB_REGION,
  DEFAULT_MODERATION_PROVIDER,
  DEFAULT_MODERATION_TIMEOUT_MS,
  DEFAULT_REDIS_URL,
  defaultBullmqPrefix,
  mainWebUrlOrigin,
  resolveAlias,
} from "@idream/shared/env";
import {
  parseGenAdapter,
  parseGenBlobAdapter,
  type GenAdapter,
  type GenBlobAdapter,
} from "./provider-vocabulary";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { z } from "zod";

const bundledWorkflowDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "workflows",
);

const positiveIntegerSchema = z.coerce.number().int().positive();

function positiveIntegerEnv(name: string, fallback: number) {
  const result = positiveIntegerSchema.safeParse(
    process.env[name] ?? fallback,
  );
  if (!result.success) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result.data;
}

export const env = {
  /**
   * Deployment environment. Feeds the queue prefix AND the production provider
   * policy in providers.ts — those read it separately before, each supplying its
   * own notion of "unset".
   */
  get APP_ENV(): string {
    return process.env.APP_ENV ?? DEFAULT_APP_ENV;
  },
  get SENTRY_DSN(): string | undefined {
    return process.env.SENTRY_DSN;
  },
  get SENTRY_RELEASE(): string | undefined {
    return process.env.SENTRY_RELEASE;
  },
  /** Redis for BullMQ. GEN_REDIS_URL wins, else shared REDIS_URL, else local. */
  get REDIS_URL(): string {
    return process.env.GEN_REDIS_URL ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  },
  // CROSS-SERVICE INVARIANT: the BullMQ prefix MUST match main (and chat) — main
  // enqueues generation jobs that gen workers consume, so a different prefix means
  // gen never sees them. The formula now lives in @idream/shared/env so there is
  // one definition instead of three copies. (Queue NAMES, not the prefix, are what
  // isolate gen/chat/main traffic within the shared Redis.)
  get BULLMQ_PREFIX(): string {
    return process.env.BULLMQ_PREFIX ?? defaultBullmqPrefix(this.APP_ENV);
  },
  get MAIN_GENERATION_TRANSPORT_URL(): string {
    return `${mainWebUrlOrigin()}/api/internal/generation/transports`;
  },
  get INTERNAL_TOKEN(): string {
    return process.env.INTERNAL_TOKEN ?? "";
  },
  /** Root dir the mock blob store writes generated assets under. */
  get BLOB_ROOT(): string {
    return resolveLocalBlobRoot();
  },
  /** Private generated media store. Use mock locally; r2/s3 in production. */
  get BLOB_PROVIDER(): GenBlobAdapter {
    return parseGenBlobAdapter(
      process.env.GEN_BLOB_PROVIDER ?? process.env.BLOB_PROVIDER ?? "mock",
    );
  },
  // INVARIANT: live reports bind the worker's exact Blob target without ever
  // serializing access keys or other write credentials.
  get BLOB_AUTHORITY(): {
    provider: GenBlobAdapter;
    endpoint: string | null;
    bucket: string | null;
    root: string | null;
  } {
    const provider = this.BLOB_PROVIDER;
    return provider === "mock"
      ? {
          provider,
          endpoint: null,
          bucket: null,
          root: this.BLOB_ROOT,
        }
      : {
          provider,
          endpoint: this.BLOB_ENDPOINT ?? null,
          bucket: this.BLOB_BUCKET ?? null,
          root: null,
        };
  },
  get BLOB_ENDPOINT(): string | undefined {
    return process.env.BLOB_ENDPOINT;
  },
  get BLOB_BUCKET(): string | undefined {
    return process.env.BLOB_BUCKET;
  },
  get BLOB_REGION(): string {
    return process.env.BLOB_REGION ?? DEFAULT_BLOB_REGION;
  },
  get BLOB_ACCESS_KEY_ID(): string | undefined {
    return resolveAlias(BLOB_ACCESS_KEY_ID_ALIASES);
  },
  get BLOB_SECRET_ACCESS_KEY(): string | undefined {
    return resolveAlias(BLOB_SECRET_ACCESS_KEY_ALIASES);
  },
  /** Image provider switch. Production uses the backend (ComfyUI/Draw Things) provider. */
  get IMAGE_PROVIDER(): GenAdapter {
    return parseGenAdapter("image", process.env.GEN_IMAGE_PROVIDER ?? "mock");
  },
  /** Video provider switch. Production can use the workflow-native backend. */
  get VIDEO_PROVIDER(): GenAdapter {
    return parseGenAdapter("video", process.env.GEN_VIDEO_PROVIDER ?? "mock");
  },
  /** Moderation provider for generation input/output gates. */
  get MODERATION_PROVIDER(): string {
    return (
      process.env.GEN_MODERATION_PROVIDER ??
      process.env.MODERATION_PROVIDER ??
      DEFAULT_MODERATION_PROVIDER
    );
  },
  get MODERATION_SERVICE_URL(): string | undefined {
    return process.env.MODERATION_SERVICE_URL;
  },
  get MODERATION_API_KEY(): string | undefined {
    return process.env.MODERATION_API_KEY;
  },
  get MODERATION_TIMEOUT_MS(): number {
    const parsed = Number.parseInt(
      process.env.MODERATION_TIMEOUT_MS ?? String(DEFAULT_MODERATION_TIMEOUT_MS),
      10,
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODERATION_TIMEOUT_MS;
  },
  get PIPELINE_API_URL(): string | undefined {
    return process.env.PIPELINE_API_URL;
  },
  get PIPELINE_API_TOKEN(): string | undefined {
    return process.env.PIPELINE_API_TOKEN;
  },
  get PIPELINE_IMAGE_MODEL_DEFAULT(): string {
    return process.env.PIPELINE_IMAGE_MODEL_DEFAULT ?? "image-default";
  },
  get PIPELINE_VIDEO_MODEL_DEFAULT(): string {
    return process.env.PIPELINE_VIDEO_MODEL_DEFAULT ?? "video-default";
  },
  get PIPELINE_IMAGE_SIZE_DEFAULT(): string | undefined {
    return process.env.PIPELINE_IMAGE_SIZE_DEFAULT;
  },
  get PIPELINE_PROFILE_DEFAULT(): string | undefined {
    return process.env.PIPELINE_PROFILE_DEFAULT;
  },
  get PIPELINE_TIMEOUT_MS(): number {
    const parsed = Number.parseInt(process.env.PIPELINE_TIMEOUT_MS ?? "60000", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
  },
  /** Long-running video generation timeout; LTX 2.3 MPS runs need a larger budget. */
  get VIDEO_TIMEOUT_MS(): number {
    return positiveIntegerEnv("GEN_VIDEO_TIMEOUT_MS", 1_800_000);
  },
  /** ComfyUI native HTTP API base URL, used by GEN_IMAGE_PROVIDER=backend. */
  get COMFYUI_API_URL(): string {
    return process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8188";
  },
  /** Official Draw Things automation CLI, used by drawthings workflows. */
  get DRAWTHINGS_CLI(): string {
    return process.env.DRAWTHINGS_CLI ?? "draw-things-cli";
  },
  /** Optional override; omitted on macOS to reuse the Draw Things app model directory. */
  get DRAWTHINGS_MODELS_DIR(): string | undefined {
    return process.env.DRAWTHINGS_MODELS_DIR;
  },
  /** Keep worker generations deterministic and prevent implicit model downloads by default. */
  get DRAWTHINGS_OFFLINE(): boolean {
    return !new Set(["0", "false", "no", "off"]).has(
      (process.env.DRAWTHINGS_OFFLINE ?? "true").trim().toLowerCase(),
    );
  },
  /** Directory of workflow descriptor JSON files (see ./backend/workflow.ts). */
  get GEN_WORKFLOW_DIR(): string {
    return process.env.GEN_WORKFLOW_DIR ?? bundledWorkflowDir;
  },
  // Video verification binaries. Declared here — not read raw at each use site —
  // because preflight.ts checks that they exist and video-media-probe.ts runs
  // them: a probe that resolves a different binary than the worker executes is
  // a green light for something that was never checked.
  get FFPROBE_BIN(): string {
    return process.env.GEN_FFPROBE_BIN ?? "ffprobe";
  },
  get FFMPEG_BIN(): string {
    return process.env.GEN_FFMPEG_BIN ?? "ffmpeg";
  },
} as const;
