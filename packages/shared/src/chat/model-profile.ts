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
  completionTimeoutMs: number;
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
  const provider = parseProvider(
    source.CHAT_MODEL_PROVIDER ?? source.CHAT_PROVIDER ?? "mock",
  );
  const defaultModel =
    source.CHAT_MODEL_NAME ??
    source.PIPELINE_CHAT_MODEL_DEFAULT ??
    DEFAULT_MODEL;
  const defaultTimeout = positiveInt(
    source.CHAT_MODEL_TIMEOUT_MS ?? source.PIPELINE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  return {
    adapter: provider === "mock" ? "mock-v1" : "openai-compatible-v1",
    provider,
    baseUrl:
      source.CHAT_MODEL_BASE_URL ??
      source.PIPELINE_API_URL ??
      DEFAULT_BASE_URL,
    model: defaultModel,
    apiKey:
      source.CHAT_MODEL_API_KEY ??
      source.PIPELINE_API_TOKEN ??
      "",
    maxOutputTokens: positiveInt(source.CHAT_MODEL_MAX_TOKENS, 8_000),
    // 0.9/0.95: companion roleplay needs more variety than the 0.6 assistant
    // default, while staying under the ~1.1 range where an 8-bit MoE starts
    // losing track of persona details. 1.05 is deliberately mild — it damps the
    // "she smiles softly" tic over a long session without punishing the repeated
    // pet names and verbal habits that make a character recognisable.
    temperature: positiveFloat(source.CHAT_MODEL_TEMPERATURE, 0.9),
    topP: positiveFloat(source.CHAT_MODEL_TOP_P, 0.95),
    repetitionPenalty: positiveFloat(source.CHAT_MODEL_REPETITION_PENALTY, 1.05),
    structuredTemperature: positiveFloat(
      source.CHAT_MODEL_STRUCTURED_TEMPERATURE,
      0.2,
    ),
    firstTokenTimeoutMs: positiveInt(
      source.CHAT_MODEL_FIRST_TOKEN_TIMEOUT_MS,
      defaultTimeout,
    ),
    idleTimeoutMs: positiveInt(
      source.CHAT_MODEL_IDLE_TIMEOUT_MS,
      defaultTimeout,
    ),
    completionTimeoutMs: positiveInt(
      source.CHAT_MODEL_COMPLETE_TIMEOUT_MS,
      defaultTimeout,
    ),
    supportsTools: provider === "openai",
  };
}

/** The one configured DSH surface that must carry live Soul canary evidence. */
export function requiredChatCanaryProfiles(source: Environment = process.env) {
  // INVARIANT: DSH has one configured provider/model surface. Plan entitlements
  // must never silently select an unproven provider alias.
  // `free` is the canonical existing evidence lane; it labels the one runtime,
  // not a plan-specific model selection.
  return [{ tier: "free", profile: resolveChatModelProfile(source) }];
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

function positiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
