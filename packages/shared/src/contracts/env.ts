import { z } from "zod";

// SPEC: the environment variables that main, chat and gen must all resolve to the
// SAME value. Defaults and formulas are defined here exactly once; each service's
// env.ts imports them instead of re-typing the literal.
//
// INVARIANT — the admission test for this file: a variable belongs here if and only
// if TWO PROCESSES RESOLVING IT TO DIFFERENT VALUES IS A BUG. Everything else is
// private config and stays in its own package (CHAT_MODEL_*, DRAWTHINGS_*,
// POCKET_TTS_*, BTCPAY_* ... none of those belong here — a service is free to
// disagree with its neighbours about them).
//
// INTENT: this file exists because BULLMQ_PREFIX proved the point the expensive way.
// The same `idream:${APP_ENV}` default was hand-copied into three env.ts files, and
// a prefix mismatch does not fail loudly — the producer enqueues, the consumer polls
// a different keyspace, and both look healthy while nothing is delivered. That class
// of bug is invisible to per-service tests, so the only real fix is one definition.
//
// INTENT: this module deliberately exports DEFINITIONS, not a parsed `env` object.
// The three services have intentionally different failure modes and must keep them:
// main parses eagerly with zod and throws at import (a misconfigured web app should
// refuse to boot); chat and gen use lazy getters that never throw on import (workers
// must be importable with no env at all, and their tests mutate process.env after
// import). A shared runtime singleton would break all three.

/** APP_ENV is the only input to the queue-prefix formula, so it is part of the contract. */
export const DEFAULT_APP_ENV = "development";
export const appEnvSchema = z.enum(["development", "test", "preview", "production"]);

/**
 * SPEC: the BullMQ key prefix. Producer and consumer MUST agree.
 * INVARIANT: this is the single definition of the formula — main, chat and gen all
 * call it rather than interpolating `idream:${...}` themselves.
 */
export function defaultBullmqPrefix(appEnv: string | undefined = DEFAULT_APP_ENV): string {
  return `idream:${appEnv ?? DEFAULT_APP_ENV}`;
}

/** Shared Redis instance. main enqueues generation jobs that gen workers consume. */
export const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";

/** Origin chat and gen call back into for internal ingest / transport callbacks. */
export const DEFAULT_MAIN_WEB_URL = "http://127.0.0.1:3000";

/**
 * INTENT: chat and gen each build a callback URL off MAIN_WEB_URL and each had their
 * own trailing-slash strip. Same base, same normalisation, one definition.
 */
export function mainWebUrlOrigin(raw: string | undefined = process.env.MAIN_WEB_URL): string {
  return (raw ?? DEFAULT_MAIN_WEB_URL).replace(/\/$/, "");
}

export const DEFAULT_CHAT_MODEL_TIMEOUT_MS = 45_000;

/**
 * SPEC: chat 调用模型时的超时预算，毫秒。
 * INTENT: chat 解析成 `CHAT_MODEL_TIMEOUT_MS ?? 45s`，而 main 的 probe-chat-model
 * 解析成 `CHAT_MODEL_TIMEOUT_MS ?? PIPELINE_TIMEOUT_MS ?? 60s` —— 多一级回退、
 * 默认值也更大。于是探针会给一次 50s 的响应打绿灯，而 chat 在生产里早把它超时掉了：
 * 一份"模型健康"的报告，说的却不是生产的行为。探针必须用生产的预算，所以两边共用
 * 这一个解析。与 mainWebUrlOrigin 同样的理由：同一个基准、同一套归一化、一处定义。
 */
export function chatModelTimeoutMs(
  raw: string | undefined = process.env.CHAT_MODEL_TIMEOUT_MS,
): number {
  const parsed = Number.parseInt(raw ?? String(DEFAULT_CHAT_MODEL_TIMEOUT_MS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHAT_MODEL_TIMEOUT_MS;
}

export const DEFAULT_MODERATION_PROVIDER = "mock";
export const moderationProviderSchema = z.enum(["mock", "pipeline", "safety-gateway"]);
export const DEFAULT_MODERATION_TIMEOUT_MS = 5_000;

/** Blob region default shared by main and gen. */
export const DEFAULT_BLOB_REGION = "auto";

/**
 * SPEC: accepted spellings for the blob credential pair, most specific first.
 * INTENT: main declares both BLOB_ACCESS_KEY and BLOB_ACCESS_KEY_ID; gen chains
 * BLOB_ACCESS_KEY_ID → BLOB_ACCESS_KEY → AWS_ACCESS_KEY_ID. These are COMPATIBILITY
 * ALIASES, not independent settings — recorded here so nobody "cleans up" one
 * spelling in one package and silently unauthenticates the other.
 */
export const BLOB_ACCESS_KEY_ID_ALIASES = [
  "BLOB_ACCESS_KEY_ID",
  "BLOB_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
] as const;
export const BLOB_SECRET_ACCESS_KEY_ALIASES = [
  "BLOB_SECRET_ACCESS_KEY",
  "BLOB_SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
] as const;

/**
 * Resolve the first alias that is set.
 * INVARIANT: matches `a ?? b ?? c` exactly — it falls through on `undefined` only,
 * NOT on the empty string. An explicitly-empty credential stays empty rather than
 * silently promoting the next alias.
 */
export function resolveAlias(
  aliases: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of aliases) {
    const value = source[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * SPEC: zod shape for the cross-service variables, for services that validate with
 * zod (today: main).
 * INTENT: chat and gen deliberately do NOT use this — they must import without
 * throwing. They consume the DEFAULT_* constants and defaultBullmqPrefix() above,
 * which is what actually has to match.
 * @param appEnv resolved APP_ENV, passed in so the caller controls whether it is
 *   captured once at module load (main) or re-read per access.
 */
export function crossServiceEnvShape(appEnv: string = DEFAULT_APP_ENV) {
  return {
    APP_ENV: appEnvSchema.default(DEFAULT_APP_ENV),
    REDIS_URL: z.string().url().default(DEFAULT_REDIS_URL),
    BULLMQ_PREFIX: z.string().min(1).default(defaultBullmqPrefix(appEnv)),
    MAIN_WEB_URL: z.string().url().optional(),
    INTERNAL_TOKEN: z.string().min(16),
    MODERATION_PROVIDER: moderationProviderSchema.default(DEFAULT_MODERATION_PROVIDER),
    MODERATION_SERVICE_URL: z.string().url().optional(),
    MODERATION_API_KEY: z.string().optional(),
    MODERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_MODERATION_TIMEOUT_MS),
    PIPELINE_API_URL: z.string().url().optional(),
    PIPELINE_API_TOKEN: z.string().optional(),
  } as const;
}

/**
 * The variable names this contract owns. Used by the drift guard test to prove no
 * service re-declares a shared default behind the contract's back.
 */
export const CROSS_SERVICE_ENV_KEYS = [
  "APP_ENV",
  "REDIS_URL",
  "BULLMQ_PREFIX",
  "INTERNAL_TOKEN",
  "MAIN_WEB_URL",
  "MODERATION_PROVIDER",
  "MODERATION_SERVICE_URL",
  "MODERATION_API_KEY",
  "MODERATION_TIMEOUT_MS",
  "PIPELINE_API_URL",
  "PIPELINE_API_TOKEN",
] as const;
