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

export const DEFAULT_LAUNCH_SCOPE = "full";
export const launchScopeSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : DEFAULT_LAUNCH_SCOPE,
  z.enum(["full", "core"]),
);
export type LaunchScope = z.infer<typeof launchScopeSchema>;

export const MAIN_LAUNCH_PROVIDER_KEYS = [
  "CHAT_PROVIDER",
  "VOICE_PROVIDER",
  "MODERATION_PROVIDER",
  "PAYMENT_PROVIDER",
  "BLOB_PROVIDER",
  "AGE_VERIFICATION_PROVIDER",
] as const;
export type MainLaunchProviderKey = (typeof MAIN_LAUNCH_PROVIDER_KEYS)[number];

const CORE_LAUNCH_PROVIDER_KEYS = [
  "CHAT_PROVIDER",
  "VOICE_PROVIDER",
  "MODERATION_PROVIDER",
  "BLOB_PROVIDER",
] as const satisfies readonly MainLaunchProviderKey[];
const CORE_NON_MOCK_PROVIDER_KEYS = [
  "CHAT_PROVIDER",
  "VOICE_PROVIDER",
  "BLOB_PROVIDER",
] as const satisfies readonly MainLaunchProviderKey[];
const FULL_NON_MOCK_PROVIDER_KEYS = [
  ...CORE_NON_MOCK_PROVIDER_KEYS,
  "PAYMENT_PROVIDER",
  "AGE_VERIFICATION_PROVIDER",
] as const satisfies readonly MainLaunchProviderKey[];

export function resolveLaunchScope(value: string | undefined): LaunchScope | null {
  const parsed = launchScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function mainProviderKeysForLaunchScope(
  scope: LaunchScope,
): readonly MainLaunchProviderKey[] {
  return scope === "core" ? CORE_LAUNCH_PROVIDER_KEYS : MAIN_LAUNCH_PROVIDER_KEYS;
}

// SPEC: mock moderation is a valid product authority in every launch scope.
// Core requires real Chat, Voice, and Blob; full adds Billing and Age Verification.
export function requiredNonMockMainProviderKeysForLaunchScope(
  scope: LaunchScope,
): readonly MainLaunchProviderKey[] {
  return scope === "core"
    ? CORE_NON_MOCK_PROVIDER_KEYS
    : FULL_NON_MOCK_PROVIDER_KEYS;
}

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

/**
 * SPEC: REDIS_URL → the connection fields ioredis needs. Structurally an ioredis
 * `RedisOptions`; typed locally so this module stays dependency-free.
 *
 * INTENT: main, chat and gen each carried a byte-identical copy of this parse.
 * It is the same failure mode BULLMQ_PREFIX proved: the `db` index comes out of
 * the URL path, so one copy drifting puts a producer and its consumer on
 * different Redis databases — nothing errors, nothing is delivered. Whatever the
 * prefix agrees on is worthless if the connections disagree.
 *
 * INVARIANT: `maxRetriesPerRequest: null` is required by BullMQ workers (a
 * blocking BRPOPLPUSH must not be aborted by ioredis' retry cap), not a
 * preference — do not "tidy" it into a number.
 */
export type RedisConnectionOptions = {
  host: string;
  port: number;
  username: string | undefined;
  password: string | undefined;
  db: number;
  tls: Record<string, never> | undefined;
  maxRetriesPerRequest: null;
};

export function redisConnectionOptions(rawUrl: string): RedisConnectionOptions {
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname && url.pathname !== "/" ? Number.parseInt(url.pathname.slice(1), 10) : 0,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** Origin chat and gen call back into for internal ingest / transport callbacks. */
export const DEFAULT_MAIN_WEB_URL = "http://127.0.0.1:3000";

/**
 * INTENT: chat and gen each build a callback URL off MAIN_WEB_URL and each had their
 * own trailing-slash strip. Same base, same normalisation, one definition.
 */
export function mainWebUrlOrigin(raw: string | undefined = process.env.MAIN_WEB_URL): string {
  return (raw ?? DEFAULT_MAIN_WEB_URL).replace(/\/$/, "");
}

/**
 * SPEC: the OpenAI-compatible endpoint an adapter calls, from a configured base
 * URL plus the route that adapter owns (`/chat/completions`, `/audio/speech`,
 * `/images/generations`, `/videos/generations`).
 *
 * INTENT: PIPELINE_API_URL is a CROSS-SERVICE variable (see crossServiceEnvShape)
 * but the two sides read it as different things. main's chat and voice adapters
 * append their route to whatever path the base carries; gen returned the base
 * UNCHANGED whenever it had any path at all, ignoring the route entirely. Both
 * .env.example files document that difference without acknowledging it:
 * main writes `.../v1`, gen writes `.../images/generations`. So gen posted image
 * requests to `/v1` under main's documented value, and — worse — posted VIDEO
 * requests to `/images/generations` under its own, because a base with a path
 * made the image and video routes resolve to the identical URL.
 *
 * INVARIANT: appending is idempotent. A base that already ends in the route is
 * returned untouched, so "point me at the complete endpoint" keeps working; a
 * base that does not gets the route appended, so "point me at the API root"
 * works too. That is the union of what the two copies each supported alone.
 */
export function pipelineEndpoint(baseUrl: string, route: string): URL {
  const url = new URL(baseUrl);
  if (url.pathname.endsWith(route)) return url;
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${route}`;
  return url;
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
