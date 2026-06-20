// SPEC: Generation service runtime config. One typed accessor; no scattered
// process.env reads. gen is a pure async worker — needs only Redis (for the
// BullMQ queues) and a blob root (mock blob store writes under it).
// INTENT: Lazy getters so importing this module never throws; tests can run
// without any env set. Config comes from packages/gen/.env (see .env.example),
// loaded here non-overriding so injected vars still win.
import "dotenv/config";
import path from "node:path";

export const env = {
  /** Redis for BullMQ. GEN_REDIS_URL wins, else shared REDIS_URL, else local. */
  get REDIS_URL(): string {
    return process.env.GEN_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
  },
  /** BullMQ key prefix — isolates gen queues from chat/main in the same Redis. */
  get BULLMQ_PREFIX(): string {
    return process.env.BULLMQ_PREFIX ?? "idream:gen";
  },
  /** Root dir the mock blob store writes generated assets under. */
  get BLOB_ROOT(): string {
    return path.resolve(process.env.BLOB_ROOT ?? "./data/gen-blob");
  },
  /** Image provider switch. Only "mock" is wired today. */
  get IMAGE_PROVIDER(): string {
    return process.env.GEN_IMAGE_PROVIDER ?? process.env.IMAGE_PROVIDER ?? "mock";
  },
  /** Video provider switch. Only "mock" is wired today. */
  get VIDEO_PROVIDER(): string {
    return process.env.GEN_VIDEO_PROVIDER ?? process.env.VIDEO_PROVIDER ?? "mock";
  },
} as const;
