// Next.js auto-loads .env for web apps; this dotenv import (non-overriding)
// gives tsx processes and sibling services the same cwd-based env loading.
import "dotenv/config";
import { z } from "zod";
import { DB_PROVIDER, DEFAULT_POSTGRES_DATABASE_URL } from "./constants";

const appEnv = process.env.APP_ENV ?? "development";
const isProductionBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.npm_lifecycle_event === "build";

const developmentSecret = "development-only-secret-change-before-production";
const allowPlaceholderSecrets = appEnv !== "production" || isProductionBuild;
const defaultDatabaseUrl =
  appEnv === "production" && !isProductionBuild ? undefined : DEFAULT_POSTGRES_DATABASE_URL;

function isPostgresUrl(value: string) {
  return value.startsWith("postgresql://") || value.startsWith("postgres://");
}

function isPublicHttpsOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)
    );
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "preview", "production"]).default("development"),
  NODE_ENV: z.string().optional(),
  DB_PROVIDER: z.literal(DB_PROVIDER).default(DB_PROVIDER),
  DATABASE_URL: z.string().min(1).refine(isPostgresUrl, {
    message: "DATABASE_URL must be a Postgres connection string",
  }),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  INTERNAL_TOKEN: z.string().min(16),
  CRON_SECRET: z.string().min(16),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379/0"),
  BULLMQ_PREFIX: z.string().min(1).default(`idream:${appEnv}`),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  CHAT_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  IMAGE_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  VIDEO_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  VOICE_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  MODERATION_PROVIDER: z.enum(["mock", "pipeline", "safety-gateway"]).default("mock"),
  PAYMENT_PROVIDER: z.enum(["mock", "btcpay"]).default("mock"),
  BLOB_PROVIDER: z.enum(["mock", "r2", "s3"]).default("mock"),
  AGE_VERIFICATION_PROVIDER: z.enum(["mock", "gocam"]).default("mock"),
  BLOB_ENDPOINT: z.string().url().optional(),
  BLOB_BUCKET: z.string().min(1).optional(),
  BLOB_REGION: z.string().min(1).default("auto"),
  BLOB_ACCESS_KEY_ID: z.string().optional(),
  BLOB_ACCESS_KEY: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  BLOB_SECRET_ACCESS_KEY: z.string().optional(),
  BLOB_SECRET_KEY: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  BTCPAY_BASE_URL: z.string().url().optional(),
  BTCPAY_STORE_ID: z.string().optional(),
  BTCPAY_API_KEY: z.string().optional(),
  BTCPAY_WEBHOOK_SECRET: z.string().optional(),
  MODERATION_SERVICE_URL: z.string().url().optional(),
  MODERATION_API_KEY: z.string().optional(),
  MODERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  PIPELINE_API_URL: z.string().url().optional(),
  PIPELINE_API_TOKEN: z.string().optional(),
  PIPELINE_CHAT_MODEL_DEFAULT: z.string().min(1).default("chat-default"),
  PIPELINE_IMAGE_MODEL_DEFAULT: z.string().min(1).default("image-default"),
  PIPELINE_VOICE_MODEL_DEFAULT: z.string().min(1).default("voice-default"),
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AGE_VERIFY_SERVICE_URL: z.string().url().optional(),
  AGE_VERIFY_API_KEY: z.string().optional(),
  AGE_VERIFY_WEBHOOK_SECRET: z.string().optional(),
  AGE_VERIFY_LINK_BACK_URL: z.string().url().optional(),
  AGE_VERIFY_CALLBACK_URL: z.string().url().optional(),
  AGE_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Chat Service split (design §1/§8). When CHAT_SERVICE_URL is set, main-web
  // reverse-proxies /api/v1/chat/* to the chat service with a signed BFF context
  // instead of handling chat in-process. Unset ⇒ monolith chat (dev/test).
  CHAT_SERVICE_URL: z.string().url().optional(),
  CHAT_BFF_SIGNING_SECRET: z.string().optional(),
}).superRefine((value, ctx) => {
  if (
    value.APP_ENV === "production" &&
    !isProductionBuild &&
    !isPublicHttpsOrigin(value.BETTER_AUTH_URL)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_URL"],
      message: "BETTER_AUTH_URL must be a public HTTPS origin in production",
    });
  }
});

const rawEnv = {
  ...process.env,
  DB_PROVIDER: process.env.DB_PROVIDER ?? DB_PROVIDER,
  DATABASE_URL: process.env.DATABASE_URL ?? defaultDatabaseUrl,
  BETTER_AUTH_URL:
    process.env.BETTER_AUTH_URL ??
    (allowPlaceholderSecrets ? "http://localhost:3000" : undefined),
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ??
    (allowPlaceholderSecrets ? developmentSecret : undefined),
  INTERNAL_TOKEN:
    process.env.INTERNAL_TOKEN ??
    (allowPlaceholderSecrets ? "development-internal-token" : undefined),
  CRON_SECRET:
    process.env.CRON_SECRET ??
    (allowPlaceholderSecrets ? "development-cron-token" : undefined),
};

export const env = EnvSchema.parse(rawEnv);
export type Env = z.infer<typeof EnvSchema>;
