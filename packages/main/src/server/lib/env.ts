// Next.js auto-loads .env for web apps; this dotenv import (non-overriding)
// gives tsx processes and sibling services the same cwd-based env loading.
import "dotenv/config";
import { z } from "zod";
import {
  DEFAULT_APP_ENV,
  DEFAULT_BLOB_REGION,
  crossServiceEnvShape,
  launchScopeSchema,
} from "@idream/shared/env";
import { isPublicHttpsUrl } from "../../lib/public-site-origin";
import { DB_PROVIDER, DEFAULT_POSTGRES_DATABASE_URL } from "./constants";

const appEnv = process.env.APP_ENV ?? DEFAULT_APP_ENV;
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

const EnvSchema = z.object({
  // Cross-service variables (APP_ENV / REDIS_URL / BULLMQ_PREFIX / INTERNAL_TOKEN /
  // MAIN_WEB_URL / MODERATION_* / PIPELINE_API_*) come from the shared contract so
  // main, chat and gen cannot drift apart. See @idream/shared/env.
  ...crossServiceEnvShape(appEnv),
  LAUNCH_SCOPE: launchScopeSchema,
  NODE_ENV: z.string().optional(),
  DB_PROVIDER: z.literal(DB_PROVIDER).default(DB_PROVIDER),
  DATABASE_URL: z.string().min(1).refine(isPostgresUrl, {
    message: "DATABASE_URL must be a Postgres connection string",
  }),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  CRON_SECRET: z.string().min(16),
  GENERATION_ROUTE_EVALUATOR_VERSION: z.string().min(1).default("identity-match-v1"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  CHAT_PROVIDER: z.enum(["mock", "pipeline"]).default("mock"),
  // Tests with no environment remain isolated on mock. Versioned local and
  // production env templates select Fish Audio as the product authority.
  VOICE_PROVIDER: z
    .enum(["mock", "pipeline", "pocket-tts", "fish-audio"])
    .default("mock"),
  PAYMENT_PROVIDER: z.enum(["mock", "btcpay"]).default("mock"),
  BLOB_PROVIDER: z.enum(["mock", "r2", "s3"]).default("mock"),
  AGE_VERIFICATION_PROVIDER: z.enum(["mock", "gocam"]).default("mock"),
  BLOB_ENDPOINT: z.string().url().optional(),
  BLOB_BUCKET: z.string().min(1).optional(),
  BLOB_REGION: z.string().min(1).default(DEFAULT_BLOB_REGION),
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
  // Read by Admin diagnostics and launch-readiness. Gen workers own provider
  // selection through GEN_IMAGE_PROVIDER / GEN_VIDEO_PROVIDER.
  COMFYUI_API_URL: z.string().url().optional(),
  PIPELINE_VOICE_API_URL: z.string().url().optional(),
  PIPELINE_VOICE_API_TOKEN: z.string().optional(),
  PIPELINE_CHAT_MODEL_DEFAULT: z
    .string()
    .min(1)
    .default("Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit"),
  PIPELINE_IMAGE_MODEL_DEFAULT: z.string().min(1).default("image-default"),
  PIPELINE_VOICE_MODEL_DEFAULT: z.string().min(1).default("voice-default"),
  // Speaker used when a character has no voiceId. Speaker-keyed TTS (e.g. Qwen3-TTS
  // or Kokoro) may reject the generic "default"; set a real speaker like "serena"
  // or "af_heart".
  PIPELINE_VOICE_DEFAULT_VOICE_ID: z.string().optional(),
  PIPELINE_VOICE_SEND_INSTRUCTIONS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  PIPELINE_VOICE_CHUNK_CHARS: z.coerce.number().int().min(0).default(0),
  PIPELINE_VOICE_MAX_INPUT_CHARS: z.coerce.number().int().min(0).default(900),
  PIPELINE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PIPELINE_VOICE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  JOB_STALE_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1_000),
  GEN_VIDEO_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1_000),
  VIDEO_JOB_STALE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(35 * 60 * 1_000),
  POCKET_TTS_API_URL: z.string().url().default("http://127.0.0.1:8062/v1"),
  POCKET_TTS_API_TOKEN: z.string().optional(),
  POCKET_TTS_MODEL: z.string().min(1).default("pocket-tts-4bit"),
  POCKET_TTS_LANGUAGE: z.literal("english").default("english"),
  POCKET_TTS_DEFAULT_VOICE_ID: z.string().min(1).default("alba"),
  POCKET_TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  POCKET_TTS_OMLX_API_URL: z.string().url().default("http://127.0.0.1:8061/v1"),
  POCKET_TTS_OMLX_API_TOKEN: z.string().optional(),
  POCKET_TTS_OMLX_RUNTIME_VERSION: z.string().min(1).default("0.5.3"),
  POCKET_TTS_OMLX_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  FISH_AUDIO_API_URL: z.string().url().default("http://127.0.0.1:8062/v1"),
  FISH_AUDIO_API_TOKEN: z.string().optional(),
  FISH_AUDIO_MODEL: z.string().min(1).default("fish-audio-s2-pro-8bit"),
  FISH_AUDIO_LANGUAGE: z.string().min(1).default("auto"),
  FISH_AUDIO_DEFAULT_VOICE_ID: z
    .string()
    .min(1)
    .default("fish-female-default"),
  FISH_AUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
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
  ADMIN_BFF_SIGNING_SECRET: z.string().min(32).optional(),
}).superRefine((value, ctx) => {
  if (value.VIDEO_JOB_STALE_TIMEOUT_MS <= value.GEN_VIDEO_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["VIDEO_JOB_STALE_TIMEOUT_MS"],
      message:
        "VIDEO_JOB_STALE_TIMEOUT_MS must be greater than GEN_VIDEO_TIMEOUT_MS",
    });
  }
  if (
    value.APP_ENV === "production" &&
    !isProductionBuild &&
    !isPublicHttpsUrl(value.BETTER_AUTH_URL)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_URL"],
      message: "BETTER_AUTH_URL must be a public HTTPS origin in production",
    });
  }
  if (
    value.APP_ENV === "production" &&
    !isProductionBuild &&
    (!value.MAIN_WEB_URL || !isPublicHttpsUrl(value.MAIN_WEB_URL))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["MAIN_WEB_URL"],
      message: "MAIN_WEB_URL must be a public HTTPS origin in production",
    });
  }
  if (value.APP_ENV === "production" && !isProductionBuild && !value.ADMIN_BFF_SIGNING_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_BFF_SIGNING_SECRET"],
      message: "ADMIN_BFF_SIGNING_SECRET is required in production",
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
