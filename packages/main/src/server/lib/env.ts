import { z } from "zod";
import { DEFAULT_SQLITE_DATABASE_URL } from "./constants";

const appEnv = process.env.APP_ENV ?? "development";
const isProductionBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.npm_lifecycle_event === "build";
const dbProvider = process.env.DB_PROVIDER ?? "sqlite";

const developmentSecret = "development-only-secret-change-before-production";
const allowPlaceholderSecrets = appEnv !== "production" || isProductionBuild;

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "preview", "production"]).default("development"),
  NODE_ENV: z.string().optional(),
  DB_PROVIDER: z.enum(["sqlite", "postgresql"]).default("sqlite"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  INTERNAL_TOKEN: z.string().min(16),
  CRON_SECRET: z.string().min(16),
  REDIS_URL: z.string().url().default("redis://127.0.0.1:6379/0"),
  BULLMQ_PREFIX: z.string().min(1).default(`idream:${appEnv}`),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  CHAT_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  IMAGE_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  VIDEO_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  VOICE_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  MODERATION_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  PAYMENT_PROVIDER: z.enum(["mock"]).default("mock"),
  BLOB_PROVIDER: z.enum(["mock"]).default("mock"),
  AGE_VERIFICATION_PROVIDER: z.enum(["mock"]).default("mock"),
});

const rawEnv = {
  ...process.env,
  DB_PROVIDER: dbProvider,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    (dbProvider === "sqlite" ? DEFAULT_SQLITE_DATABASE_URL : undefined),
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
