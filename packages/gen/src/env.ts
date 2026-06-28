// SPEC: Generation service runtime config. One typed accessor; no scattered
// process.env reads. gen is a pure async worker — needs only Redis (for the
// BullMQ queues) and a blob root (mock blob store writes under it).
// INTENT: Lazy getters so importing this module never throws; tests can run
// without any env set. Config comes from packages/gen/.env (see .env.example),
// loaded here non-overriding so injected vars still win.
import { resolveLocalBlobRoot } from "@idream/shared/storage/local-blob";
import "dotenv/config";

export const env = {
  /** Redis for BullMQ. GEN_REDIS_URL wins, else shared REDIS_URL, else local. */
  get REDIS_URL(): string {
    return process.env.GEN_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
  },
  // CROSS-SERVICE INVARIANT: the BullMQ prefix MUST match main (and chat) — main
  // enqueues generation jobs that gen workers consume, so a different prefix means
  // gen never sees them. Default mirrors main's `idream:${APP_ENV}`. (Queue NAMES,
  // not the prefix, are what isolate gen/chat/main traffic within the shared Redis.)
  get BULLMQ_PREFIX(): string {
    return process.env.BULLMQ_PREFIX ?? `idream:${process.env.APP_ENV ?? "development"}`;
  },
  /** Root dir the mock blob store writes generated assets under. */
  get BLOB_ROOT(): string {
    return resolveLocalBlobRoot();
  },
  /** Private generated media store. Use mock locally; r2/s3 in production. */
  get BLOB_PROVIDER(): string {
    return process.env.GEN_BLOB_PROVIDER ?? process.env.BLOB_PROVIDER ?? "mock";
  },
  get BLOB_ENDPOINT(): string | undefined {
    return process.env.BLOB_ENDPOINT;
  },
  get BLOB_BUCKET(): string | undefined {
    return process.env.BLOB_BUCKET;
  },
  get BLOB_REGION(): string {
    return process.env.BLOB_REGION ?? "auto";
  },
  get BLOB_ACCESS_KEY_ID(): string | undefined {
    return process.env.BLOB_ACCESS_KEY_ID ?? process.env.BLOB_ACCESS_KEY ?? process.env.AWS_ACCESS_KEY_ID;
  },
  get BLOB_SECRET_ACCESS_KEY(): string | undefined {
    return (
      process.env.BLOB_SECRET_ACCESS_KEY ??
      process.env.BLOB_SECRET_KEY ??
      process.env.AWS_SECRET_ACCESS_KEY
    );
  },
  /** Image provider switch. Production uses the pipeline gateway. */
  get IMAGE_PROVIDER(): string {
    return process.env.GEN_IMAGE_PROVIDER ?? process.env.IMAGE_PROVIDER ?? "mock";
  },
  /** Video provider switch. Production uses the pipeline gateway when video is enabled. */
  get VIDEO_PROVIDER(): string {
    return process.env.GEN_VIDEO_PROVIDER ?? process.env.VIDEO_PROVIDER ?? "mock";
  },
  /** Moderation provider for generation input/output gates. */
  get MODERATION_PROVIDER(): string {
    return process.env.GEN_MODERATION_PROVIDER ?? process.env.MODERATION_PROVIDER ?? "mock";
  },
  get MODERATION_SERVICE_URL(): string | undefined {
    return process.env.MODERATION_SERVICE_URL;
  },
  get MODERATION_API_KEY(): string | undefined {
    return process.env.MODERATION_API_KEY;
  },
  get MODERATION_TIMEOUT_MS(): number {
    const parsed = Number.parseInt(process.env.MODERATION_TIMEOUT_MS ?? "5000", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
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
} as const;
