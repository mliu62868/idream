export type ChatModelProvider = "mock" | "openai" | "pipeline";

export interface ChatModelProfile {
  provider: ChatModelProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxOutputTokens: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  completionTimeoutMs: number;
  supportsTools: boolean;
}

export interface ChatMemoryExtractProfile {
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

type Environment = Record<string, string | undefined>;

const DEFAULT_MODEL =
  "Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit";
const DEFAULT_BASE_URL = "http://127.0.0.1:8061/v1";
const DEFAULT_TIMEOUT_MS = 45_000;

/** One resolver for production, policy, probes, readiness and diagnostics. */
export function resolveChatModelProfile(
  source: Environment = process.env,
  tier: string = "free",
): ChatModelProfile {
  const provider = parseProvider(
    source.CHAT_MODEL_PROVIDER ?? source.CHAT_PROVIDER ?? "mock",
  );
  const defaultModel =
    source.CHAT_MODEL_NAME ??
    source.PIPELINE_CHAT_MODEL_DEFAULT ??
    DEFAULT_MODEL;
  const model = tier === "deluxe"
    ? source.CHAT_MODEL_DELUXE ?? defaultModel
    : tier === "premium"
      ? source.CHAT_MODEL_PREMIUM ?? defaultModel
      : source.CHAT_MODEL_FREE ?? defaultModel;
  const legacyTimeout = positiveInt(
    source.CHAT_MODEL_TIMEOUT_MS ?? source.PIPELINE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  return {
    provider,
    baseUrl:
      source.CHAT_MODEL_BASE_URL ??
      source.PIPELINE_API_URL ??
      DEFAULT_BASE_URL,
    model,
    apiKey:
      source.CHAT_MODEL_API_KEY ??
      source.PIPELINE_API_TOKEN ??
      "",
    maxOutputTokens: positiveInt(source.CHAT_MODEL_MAX_TOKENS, 8_000),
    firstTokenTimeoutMs: positiveInt(
      source.CHAT_MODEL_FIRST_TOKEN_TIMEOUT_MS,
      legacyTimeout,
    ),
    idleTimeoutMs: positiveInt(
      source.CHAT_MODEL_IDLE_TIMEOUT_MS,
      legacyTimeout,
    ),
    completionTimeoutMs: positiveInt(
      source.CHAT_MODEL_COMPLETE_TIMEOUT_MS,
      legacyTimeout,
    ),
    supportsTools: provider === "openai",
  };
}

export function resolveChatMemoryExtractProfile(
  source: Environment = process.env,
): ChatMemoryExtractProfile {
  const chat = resolveChatModelProfile(source);
  return {
    model: source.CHAT_MEMORY_EXTRACT_MODEL ?? "Qwen3.5-4B-MLX-4bit",
    baseUrl: source.CHAT_MEMORY_EXTRACT_LLM_URL ?? chat.baseUrl,
    apiKey: source.CHAT_MEMORY_EXTRACT_LLM_KEY ?? chat.apiKey ?? "omlx",
    timeoutMs: positiveInt(source.CHAT_MEMORY_EXTRACT_TIMEOUT_MS, 45_000),
  };
}

function parseProvider(value: string): ChatModelProvider {
  if (value === "mock" || value === "openai" || value === "pipeline") {
    return value;
  }
  throw new Error(
    `CHAT_MODEL_PROVIDER=${value} unsupported (use "mock", "openai", or "pipeline")`,
  );
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
