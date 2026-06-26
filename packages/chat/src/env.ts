// SPEC: Chat service runtime config. Fail fast on missing required secrets.
// INTENT: One typed accessor; no scattered process.env reads. All config comes
// from packages/chat/.env (see .env.example) — loaded here, non-overriding so
// vitest/pm2-injected vars still win.
import "dotenv/config";
import path from "node:path";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const env = {
  get DATABASE_URL() {
    return required("CHAT_DATABASE_URL", process.env.DATABASE_URL);
  },
  get REDIS_URL() {
    return process.env.CHAT_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
  },
  get BULLMQ_PREFIX() {
    return process.env.BULLMQ_PREFIX ?? "idream:chat";
  },
  get CHAT_FS_ROOT() {
    return path.resolve(process.env.CHAT_FS_ROOT ?? "./data/chat");
  },
  get CHAT_MODEL_PROVIDER() {
    return process.env.CHAT_MODEL_PROVIDER ?? process.env.CHAT_PROVIDER ?? "mock";
  },
  // OpenAI-compatible chat model (local mlx via oMLX / LM Studio, or any OpenAI
  // API). Only read when CHAT_MODEL_PROVIDER=openai. Base URL includes /v1.
  get CHAT_MODEL_BASE_URL() {
    return process.env.CHAT_MODEL_BASE_URL ?? process.env.PIPELINE_API_URL ?? "http://127.0.0.1:8061/v1";
  },
  get CHAT_MODEL_NAME() {
    return process.env.CHAT_MODEL_NAME ?? process.env.PIPELINE_CHAT_MODEL_DEFAULT ?? "Qwen3.5-0.8B-8bit";
  },
  get CHAT_MODEL_API_KEY() {
    return process.env.CHAT_MODEL_API_KEY ?? process.env.PIPELINE_API_TOKEN ?? "";
  },
  get MODERATION_PROVIDER() {
    return process.env.CHAT_MODERATION_PROVIDER ?? process.env.MODERATION_PROVIDER ?? "mock";
  },
  get MODERATION_SERVICE_URL() {
    return process.env.CHAT_MODERATION_SERVICE_URL ?? process.env.MODERATION_SERVICE_URL ?? "";
  },
  get MODERATION_API_KEY() {
    return process.env.CHAT_MODERATION_API_KEY ?? process.env.MODERATION_API_KEY ?? "";
  },
  get MODERATION_TIMEOUT_MS() {
    const raw = process.env.CHAT_MODERATION_TIMEOUT_MS ?? process.env.MODERATION_TIMEOUT_MS ?? "5000";
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
  },
  get BFF_SIGNING_SECRET() {
    return process.env.CHAT_BFF_SIGNING_SECRET ?? "";
  },
  get PORT() {
    return Number.parseInt(process.env.CHAT_PORT ?? "3100", 10);
  },
  // Long-term memory retrieval strategy (PLAN P1-2). "recency" (default) is the
  // safe hot-path baseline; "igrep" attempts semantic ranking with a strict
  // timeout that degrades back to recency (P0 hot path must not depend on igrep).
  get MEMORY_RETRIEVAL() {
    return process.env.CHAT_MEMORY_RETRIEVAL === "igrep" ? "igrep" : "recency";
  },
  get MEMORY_RETRIEVAL_TIMEOUT_MS() {
    return Number.parseInt(process.env.CHAT_MEMORY_RETRIEVAL_TIMEOUT_MS ?? "1500", 10);
  },
  get IGREP_BIN() {
    return process.env.IGREP_BIN ?? "igrep";
  },
} as const;
