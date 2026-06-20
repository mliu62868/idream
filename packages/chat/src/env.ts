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
  get MODERATION_PROVIDER() {
    return process.env.MODERATION_PROVIDER ?? "mock";
  },
  get BFF_SIGNING_SECRET() {
    return process.env.CHAT_BFF_SIGNING_SECRET ?? "";
  },
  get PORT() {
    return Number.parseInt(process.env.CHAT_PORT ?? "3100", 10);
  },
} as const;
