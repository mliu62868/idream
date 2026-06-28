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
  // CROSS-SERVICE INVARIANT: the BullMQ prefix MUST be identical across main, chat,
  // and gen, because the cross-service queues (chat.inbound, main.inbound) are
  // produced by one service and consumed by another — a mismatch silently drops
  // every event (recent-chat projection, account erasure, …). Default mirrors
  // main's `idream:${APP_ENV}` so an un-overridden dev stack already agrees.
  get BULLMQ_PREFIX() {
    return process.env.BULLMQ_PREFIX ?? `idream:${process.env.APP_ENV ?? "development"}`;
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
  // Tier → real model aliases (design P0-D). The policy resolver maps an
  // entitlement tier to ONE of these; the provider streams with the resolved
  // model so Premium/Deluxe "premium chat models" are a real, enforced benefit —
  // not a label. Each defaults to CHAT_MODEL_NAME so a single-model deploy still
  // works unchanged.
  get CHAT_MODEL_FREE() {
    return process.env.CHAT_MODEL_FREE ?? this.CHAT_MODEL_NAME;
  },
  get CHAT_MODEL_PREMIUM() {
    return process.env.CHAT_MODEL_PREMIUM ?? this.CHAT_MODEL_NAME;
  },
  get CHAT_MODEL_DELUXE() {
    return process.env.CHAT_MODEL_DELUXE ?? this.CHAT_MODEL_NAME;
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
  // Shared secret for main-web → chat internal admin API (/internal/admin/*).
  // Empty ⇒ internal endpoints reject all callers (safe default).
  get INTERNAL_TOKEN() {
    return process.env.INTERNAL_TOKEN ?? "";
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
    const parsed = Number.parseInt(process.env.CHAT_MEMORY_EXTRACT_TIMEOUT_MS ?? "45000", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 45_000;
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
    return process.env.CHAT_MEMORY_EXTRACT_MODEL ?? "Qwen3.5-4B-MLX-4bit";
  },
  // OpenAI-compatible endpoint igrep's extractor calls. Reuses the chat model
  // endpoint/key (omlx) by default, with dedicated overrides.
  get MEMORY_EXTRACT_LLM_URL() {
    return process.env.CHAT_MEMORY_EXTRACT_LLM_URL ?? this.CHAT_MODEL_BASE_URL;
  },
  get MEMORY_EXTRACT_LLM_KEY() {
    return process.env.CHAT_MEMORY_EXTRACT_LLM_KEY ?? this.CHAT_MODEL_API_KEY ?? "omlx";
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
