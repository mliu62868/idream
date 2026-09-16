export type ChatModelProvider = "mock" | "openai" | "pipeline";

export interface ChatModelProfile {
  adapter: "mock-v1" | "openai-compatible-v1";
  provider: ChatModelProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxOutputTokens: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  supportsTools: boolean;
  // SPEC: sampling ships with the code, not with the model server's own config.
  // INTENT: the local oMLX defaults (temp 0.6, repetition_penalty 1.0) live in an
  // unversioned machine-local file, so reply quality silently changed per host.
  // INVARIANT: resolveChatModelProfile always fills all four; they are optional
  // only so readiness/probe fixtures can build a profile without restating them.
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
  /** complete() plans tools and extracts JSON — near-deterministic, not in-character. */
  structuredTemperature?: number;
}

type Environment = Record<string, string | undefined>;

const DEFAULT_MODEL =
  "Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit";
const DEFAULT_BASE_URL = "http://127.0.0.1:8061/v1";
const DEFAULT_TIMEOUT_MS = 45_000;

/** One resolver for production, policy, probes, readiness and diagnostics. */
export function resolveChatModelProfile(
  source: Environment = process.env,
): ChatModelProfile {
  const provider = parseProvider(source.CHAT_MODEL_PROVIDER ?? "mock");
  const defaultModel = source.CHAT_MODEL_NAME ?? DEFAULT_MODEL;
  const defaultTimeout = positiveInt(
    source.CHAT_MODEL_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  return {
    adapter: provider === "mock" ? "mock-v1" : "openai-compatible-v1",
    provider,
    baseUrl: source.CHAT_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
    model: defaultModel,
    apiKey: source.CHAT_MODEL_API_KEY ?? "",
    maxOutputTokens: positiveInt(source.CHAT_MODEL_MAX_TOKENS, 8_000),
    // 0.9/0.95: companion roleplay needs more variety than the 0.6 assistant
    // default, while staying under the ~1.1 range where an 8-bit MoE starts
    // losing track of persona details. 1.05 is deliberately mild — it damps the
    // "she smiles softly" tic over a long session without punishing the repeated
    // pet names and verbal habits that make a character recognisable.
    temperature: closedRangeFloat(
      source.CHAT_MODEL_TEMPERATURE,
      0.9,
      "CHAT_MODEL_TEMPERATURE",
      0,
      2,
    ),
    topP: positiveBoundedFloat(source.CHAT_MODEL_TOP_P, 0.95, "CHAT_MODEL_TOP_P", 1),
    repetitionPenalty: positiveBoundedFloat(
      source.CHAT_MODEL_REPETITION_PENALTY,
      1.05,
      "CHAT_MODEL_REPETITION_PENALTY",
      2,
    ),
    structuredTemperature: closedRangeFloat(
      source.CHAT_MODEL_STRUCTURED_TEMPERATURE,
      0.2,
      "CHAT_MODEL_STRUCTURED_TEMPERATURE",
      0,
      2,
    ),
    firstTokenTimeoutMs: positiveInt(
      source.CHAT_MODEL_FIRST_TOKEN_TIMEOUT_MS,
      defaultTimeout,
    ),
    idleTimeoutMs: positiveInt(
      source.CHAT_MODEL_IDLE_TIMEOUT_MS,
      defaultTimeout,
    ),
    supportsTools: provider === "openai",
  };
}

/** The small judge that decides image intent for languages the matchers miss. */
export interface ChatIntentModel {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

/**
 * SPEC: resolve the intent judge, or null when none is configured.
 * INTENT: unset must degrade to "the deterministic matchers are the whole
 * authority", never to "let the roleplay model decide" — the roleplay model
 * reads persona and memory, which is exactly what may not reach this decision.
 * INVARIANT: it shares the chat server and key; only the model name differs,
 * so a deployment cannot point the judge at an unrelated endpoint by accident.
 */
export function resolveChatIntentModel(
  source: Environment = process.env,
): ChatIntentModel | null {
  const model = source.CHAT_INTENT_MODEL_NAME?.trim();
  if (!model) return null;
  return {
    baseUrl: source.CHAT_MODEL_BASE_URL ?? DEFAULT_BASE_URL,
    model,
    apiKey: source.CHAT_MODEL_API_KEY ?? "",
    // A judge slower than this is worse than no judge: the user is waiting on a
    // reply that the deterministic matchers were already willing to produce.
    timeoutMs: positiveInt(source.CHAT_INTENT_TIMEOUT_MS, 2_500),
  };
}

export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  return new URL(baseUrl).hostname === "openrouter.ai";
}

/** The one configured DSH surface that must carry live Soul canary evidence. */
export function requiredChatCanaryProfiles(source: Environment = process.env) {
  // INVARIANT: DSH has one configured provider/model surface. Plan entitlements
  // must never silently select an unproven provider alias.
  // `free` is the canonical existing evidence lane; it labels the one runtime,
  // not a plan-specific model selection.
  return [{ tier: "free" as const, profile: resolveChatModelProfile(source) }];
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

function closedRangeFloat(
  value: string | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function positiveBoundedFloat(
  value: string | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${field} must be greater than 0 and at most ${maximum}`);
  }
  return parsed;
}
