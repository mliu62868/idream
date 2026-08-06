// SPEC: Chat service runtime config. Fail fast on missing required secrets.
// INTENT: One typed accessor; no scattered process.env reads. All config comes
// from packages/chat/.env (see .env.example) — loaded here, non-overriding so
// vitest/pm2-injected vars still win.
// NOTE: cwd-based. Works under `next dev` and a FULL `pm2 start ecosystem.config.js`
// (pm2 sets cwd=packages/chat). `pm2 start --only chat` does NOT apply the per-app
// cwd, so start chat via the full ecosystem (or `bun run pm2:start`), not `--only`.
import "dotenv/config";
import path from "node:path";
import {
  DEFAULT_MODERATION_PROVIDER,
  DEFAULT_MODERATION_TIMEOUT_MS,
  DEFAULT_REDIS_URL,
  defaultBullmqPrefix,
  mainWebUrlOrigin,
} from "@idream/shared/env";
import {
  resolveChatMemoryExtractProfile,
  resolveChatModelProfile,
} from "@idream/shared";

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
  get PROJECTOR_DATABASE_URL() {
    const explicit = process.env.CHAT_PROJECTOR_DATABASE_URL;
    if (explicit) return explicit;
    const url = new URL(this.DATABASE_URL);
    url.username = "chat_projector";
    url.password = required("CHAT_PROJECTOR_PASSWORD");
    return url.toString();
  },
  get REDIS_URL() {
    return process.env.CHAT_REDIS_URL ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  },
  // BullMQ is receiver-local wake-up/work scheduling; cross-service events use
  // durable HTTP ingest and do not depend on a shared Redis prefix. The default
  // still comes from the shared contract so chat cannot drift off main/gen if
  // that ever stops being true.
  get BULLMQ_PREFIX() {
    return process.env.BULLMQ_PREFIX ?? defaultBullmqPrefix(process.env.APP_ENV);
  },
  get CHAT_FS_ROOT() {
    return path.resolve(process.env.CHAT_FS_ROOT ?? "./data/chat");
  },
  get CHAT_MODEL_PROVIDER() {
    return resolveChatModelProfile(process.env).provider;
  },
  // OpenAI-compatible chat model (local mlx via oMLX / LM Studio, or any OpenAI
  // API). Only read when CHAT_MODEL_PROVIDER=openai. Base URL includes /v1.
  get CHAT_MODEL_BASE_URL() {
    return resolveChatModelProfile(process.env).baseUrl;
  },
  get CHAT_MODEL_NAME() {
    return resolveChatModelProfile(process.env).model;
  },
  get CHAT_MODEL_MAX_TOKENS() {
    return resolveChatModelProfile(process.env).maxOutputTokens;
  },
  // 与 main 的 probe-chat-model 共用同一个解析 —— 探针的预算必须就是生产的预算。
  get CHAT_MODEL_TIMEOUT_MS() {
    return resolveChatModelProfile(process.env).idleTimeoutMs;
  },
  get CHAT_MODEL_FIRST_TOKEN_TIMEOUT_MS() {
    return resolveChatModelProfile(process.env).firstTokenTimeoutMs;
  },
  get CHAT_MODEL_IDLE_TIMEOUT_MS() {
    return resolveChatModelProfile(process.env).idleTimeoutMs;
  },
  get CHAT_MODEL_COMPLETE_TIMEOUT_MS() {
    return resolveChatModelProfile(process.env).completionTimeoutMs;
  },
  // Tier → real model aliases (design P0-D). The policy resolver maps an
  // entitlement tier to ONE of these; the provider streams with the resolved
  // model so Premium/Deluxe "premium chat models" are a real, enforced benefit —
  // not a label. Each defaults to CHAT_MODEL_NAME so a single-model deploy still
  // works unchanged.
  get CHAT_MODEL_FREE() {
    return resolveChatModelProfile(process.env, "free").model;
  },
  get CHAT_MODEL_PREMIUM() {
    return resolveChatModelProfile(process.env, "premium").model;
  },
  get CHAT_MODEL_DELUXE() {
    return resolveChatModelProfile(process.env, "deluxe").model;
  },
  get CHAT_MODEL_API_KEY() {
    return resolveChatModelProfile(process.env).apiKey;
  },
  get MODERATION_PROVIDER() {
    return (
      process.env.CHAT_MODERATION_PROVIDER ??
      process.env.MODERATION_PROVIDER ??
      DEFAULT_MODERATION_PROVIDER
    );
  },
  get MODERATION_SERVICE_URL() {
    return process.env.CHAT_MODERATION_SERVICE_URL ?? process.env.MODERATION_SERVICE_URL ?? "";
  },
  get MODERATION_API_KEY() {
    return process.env.CHAT_MODERATION_API_KEY ?? process.env.MODERATION_API_KEY ?? "";
  },
  get MODERATION_TIMEOUT_MS() {
    const raw =
      process.env.CHAT_MODERATION_TIMEOUT_MS ??
      process.env.MODERATION_TIMEOUT_MS ??
      String(DEFAULT_MODERATION_TIMEOUT_MS);
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODERATION_TIMEOUT_MS;
  },
  get BFF_SIGNING_SECRET() {
    return process.env.CHAT_BFF_SIGNING_SECRET ?? "";
  },
  // Shared secret for main-web → chat internal admin API (/internal/admin/*).
  // Empty ⇒ internal endpoints reject all callers (safe default).
  get INTERNAL_TOKEN() {
    return process.env.INTERNAL_TOKEN ?? "";
  },
  get MAIN_INTERNAL_INGEST_URL() {
    return `${mainWebUrlOrigin()}/api/internal/events/ingest`;
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
  // Long-term memory EXTRACTION strategy (P1-C). "heuristic" (default) is the
  // deterministic EN/ZH regex; "igrep" uses `igrep mem derive --llm` to pull
  // structured observations off the turn, degrading to the regex on
  // timeout/error/empty. Runs OFF the hot path (chat.memory.extract worker), so
  // a slow LLM only delays memory writes, never replies.
  get MEMORY_EXTRACT() {
    return process.env.CHAT_MEMORY_EXTRACT === "igrep" ? "igrep" : "heuristic";
  },
  get MEMORY_EXTRACT_TIMEOUT_MS() {
    return resolveChatMemoryExtractProfile(process.env).timeoutMs;
  },
  // Whether the igrep extractor passes --llm (semantic). Default on in igrep mode;
  // set CHAT_MEMORY_EXTRACT_LLM=false to use igrep's deterministic path only.
  get MEMORY_EXTRACT_LLM() {
    return process.env.CHAT_MEMORY_EXTRACT_LLM !== "false";
  },
  // Model for `igrep mem derive --llm`. Defaults to the omlx reasoning model the
  // product chose; pair it with EXTRA_BODY below to disable thinking so it emits
  // parseable observations[] JSON.
  get MEMORY_EXTRACT_MODEL() {
    return resolveChatMemoryExtractProfile(process.env).model;
  },
  // OpenAI-compatible endpoint igrep's extractor calls. Reuses the chat model
  // endpoint/key (omlx) by default, with dedicated overrides.
  get MEMORY_EXTRACT_LLM_URL() {
    return resolveChatMemoryExtractProfile(process.env).baseUrl;
  },
  get MEMORY_EXTRACT_LLM_KEY() {
    return resolveChatMemoryExtractProfile(process.env).apiKey;
  },
  // Extra OpenAI request body passed to the extractor's LLM. Default disables
  // Qwen "thinking" (reasoning prose breaks the observations[] JSON parse). Set
  // CHAT_MEMORY_EXTRACT_EXTRA_BODY="" for a non-reasoning model.
  get MEMORY_EXTRACT_EXTRA_BODY() {
    return process.env.CHAT_MEMORY_EXTRACT_EXTRA_BODY ?? '{"chat_template_kwargs": {"enable_thinking": false}}';
  },
  get IGREP_BIN() {
    return process.env.IGREP_BIN ?? "igrep";
  },
} as const;
