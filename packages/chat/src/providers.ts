// SPEC: Chat service only needs two providers — the chat model (streaming) and
// moderation (input/output). Slim, self-contained; no image/video/payment/blob.
// INTENT: keep the chat deploy artifact thin (design §10 dependency isolation).
import { SafetyGatewayModerationProvider } from "@idream/shared";
import { env } from "./env.js";

export interface ChatChunk {
  delta: string;
  done: boolean;
  /** Accumulated tool calls, present on the final (done) chunk once the SSE stream closes. */
  toolCalls?: ChatToolCall[];
}

// SPEC: a function-calling tool description passed to the model, JSON-Schema
// parameters sourced from the (later task's) tool registry's zod schemas.
export type ChatToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// INVARIANT: arguments is the raw JSON string as streamed by the model —
// callers parse/validate it, providers.ts never interprets tool semantics.
export type ChatToolCall = { id: string; name: string; arguments: string };

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // INVARIANT: only meaningful on an "assistant" message that is replaying a
  // function-calling turn back to the model (the FC follow-up call, task P4-3).
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  // INVARIANT: only meaningful on a "tool" message — must echo the tool_calls[].id above.
  tool_call_id?: string;
}

export interface ChatCompletion {
  content: string;
}

export interface ChatModel {
  /** Capability flag: can this provider accept `tools` and stream tool_calls? */
  readonly supportsTools?: boolean;
  stream(input: {
    /** Real provider model resolved from the entitlement tier (policy.modelForTier). */
    model?: string;
    messages: ModelMessage[];
    characterName?: string;
    tools?: ChatToolDefinition[];
  }): AsyncIterable<ChatChunk>;
  complete(input: {
    /** Real provider model resolved from the entitlement tier (policy.modelForTier). */
    model?: string;
    messages: ModelMessage[];
    maxTokens?: number;
  }): Promise<ChatCompletion>;
}

export interface ModerationResult {
  status: "passed" | "flagged" | "blocked";
  policyCode?: string;
  confidence: number;
}

export interface ModerationProvider {
  check(input: { targetType: "text"; content: string }): Promise<ModerationResult>;
}

class MockChatModel implements ChatModel {
  // SPEC: dev/test seam so P4 tests can exercise the "FC unavailable" fallback
  // path (planner) against a mock provider without a real pipeline model.
  get supportsTools(): boolean {
    return process.env.CHAT_MOCK_SUPPORTS_TOOLS !== "false";
  }

  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    const lastUser =
      [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const reply = `Mock ${input.characterName ?? "character"} reply: ${lastUser}`.trim();
    // chunk into a few deltas so SSE/seq logic is exercised
    for (const piece of chunk(reply, 24)) yield { delta: piece, done: false };
    yield { delta: "", done: true, toolCalls: readMockToolCalls() };
  }

  async complete(): Promise<ChatCompletion> {
    return { content: process.env.CHAT_MOCK_TOOL_PLAN_JSON ?? "{\"tool\":null}" };
  }
}

// SPEC: dev/test seam for exercising the P4 agent's function-calling path
// without a real model. INTENT: same shape as the OpenAI-compatible provider's
// accumulated tool_calls, so callers don't branch on provider.
function readMockToolCalls(): ChatToolCall[] {
  const raw = process.env.CHAT_MOCK_TOOL_CALLS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatToolCall[]) : [];
  } catch (error) {
    console.warn("CHAT_MOCK_TOOL_CALLS_JSON is not valid JSON; ignoring", error);
    return [];
  }
}

// SPEC: stream from any OpenAI-compatible /chat/completions endpoint (SSE).
// Local default targets oMLX (Apple-Silicon mlx server) on :8061 with a Qwen
// model — see packages/chat/.env. INVARIANT: yields only assistant `content`
// deltas; a reasoning model's `reasoning_content` is dropped so thinking never
// leaks into the reply. EXAMPLE: provider=openai, model=Qwen3.5-4B-MLX-4bit.
class OpenAIChatModel implements ChatModel {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
    // "pipeline" is the production gateway alias and does not (yet) expose
    // function-calling; "openai" targets oMLX/LM Studio directly, which does.
    readonly supportsTools: boolean = true,
  ) {}

  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    // Per-turn model from policy (tier-resolved) wins; fall back to the deploy
    // default so an un-tiered config still streams (design P0-D).
    const model = input.model || this.model;
    const controller = new AbortController();
    const timeoutMs = env.CHAT_MODEL_TIMEOUT_MS;
    // INVARIANT: this is an IDLE timeout, not a total one. A reasoning model can stream a
    // long reply for far more than timeoutMs of wall-clock (each delta awaits a Redis write
    // downstream), so a single timer spanning the whole stream would abort a healthy slow
    // reply mid-flight — leaving the assistant message stuck empty with no retry. We reset
    // it on every received chunk below; only a connection silent for timeoutMs (truly hung) aborts.
    let timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(chatCompletionEndpoint(this.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
        // INVARIANT: Qwen reasoning models (4B/27B via oMLX/SGLang/vLLM) stream their
        // chain-of-thought into BOTH `reasoning_content` AND `content`. Dropping
        // reasoning_content (below) is not enough; we must also disable thinking at the
        // template level or "Thinking Process:" leaks into the reply. `chat_template_kwargs`
        // is honored by self-hosted OpenAI-compatible servers (the product's only target;
        // hosted OpenAI is not used) and is a no-op for non-reasoning models (0.8B).
        body: JSON.stringify({
          model,
          messages: input.messages,
          stream: true,
          max_tokens: env.CHAT_MODEL_MAX_TOKENS,
          chat_template_kwargs: { enable_thinking: false },
          ...(input.tools && input.tools.length > 0
            ? {
                tools: input.tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Chat model HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      // INVARIANT: tool_calls stream as fragments keyed by `index` — the first
      // fragment for a slot carries id+name, later ones only append to
      // `arguments`. Accumulate by index and flatten once the stream ends.
      const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
        // Reset the idle timer: progress was made, so the stream is alive.
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        buffer += decoder.decode(bytes, { stream: true });
        // SSE frames are separated by a blank line; events carry `data: <json>`.
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            yield { delta: "", done: true, toolCalls: flattenToolCalls(toolCallsByIndex) };
            return;
          }
          const delta = (JSON.parse(payload).choices?.[0]?.delta ?? {}) as {
            content?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          accumulateToolCalls(toolCallsByIndex, delta.tool_calls);
          if (delta.content) yield { delta: delta.content, done: false };
        }
      }
      yield { delta: "", done: true, toolCalls: flattenToolCalls(toolCallsByIndex) };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Chat model request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(input: Parameters<ChatModel["complete"]>[0]): Promise<ChatCompletion> {
    const model = input.model || this.model;
    const controller = new AbortController();
    const timeoutMs = env.CHAT_MODEL_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(chatCompletionEndpoint(this.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: input.messages,
          stream: false,
          max_tokens: input.maxTokens ?? Math.min(env.CHAT_MODEL_MAX_TOKENS, 1_400),
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!res.ok) {
        throw new Error(`Chat model HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      return { content: typeof content === "string" ? content : "" };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Chat model request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const BLOCKED_TERMS = ["underage", "minor", "csam"];

class MockModerationProvider implements ModerationProvider {
  async check(input: { targetType: "text"; content: string }): Promise<ModerationResult> {
    const lowered = input.content.toLowerCase();
    const term = BLOCKED_TERMS.find((t) => lowered.includes(t));
    if (term) {
      return {
        status: "blocked",
        policyCode: term === "csam" ? "potential_underage_content" : "age_under_18",
        confidence: 0.99,
      };
    }
    return { status: "passed", confidence: 0.5 };
  }
}

class SafetyGatewayChatModerationProvider implements ModerationProvider {
  private readonly gateway: SafetyGatewayModerationProvider;

  constructor(config: { serviceUrl: string; apiKey: string; timeoutMs: number }) {
    this.gateway = new SafetyGatewayModerationProvider(config);
  }

  async check(input: { targetType: "text"; content: string }): Promise<ModerationResult> {
    const result = await this.gateway.check(input);
    if (result.ok) return result.data;

    return {
      status: "blocked",
      policyCode: result.error.code,
      confidence: 1,
    };
  }
}

function accumulateToolCalls(
  byIndex: Map<number, { id: string; name: string; arguments: string }>,
  fragments: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined,
): void {
  if (!fragments) return;
  for (const fragment of fragments) {
    const existing = byIndex.get(fragment.index) ?? { id: "", name: "", arguments: "" };
    byIndex.set(fragment.index, {
      id: fragment.id ?? existing.id,
      name: fragment.function?.name ?? existing.name,
      arguments: existing.arguments + (fragment.function?.arguments ?? ""),
    });
  }
}

function flattenToolCalls(
  byIndex: Map<number, { id: string; name: string; arguments: string }>,
): ChatToolCall[] {
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
}

function chunk(text: string, size: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export interface ChatProviders {
  chat: ChatModel;
  moderation: ModerationProvider;
}

function createModerationProvider(): ModerationProvider {
  switch (env.MODERATION_PROVIDER) {
    case "mock":
      return new MockModerationProvider();
    case "safety-gateway":
      return new SafetyGatewayChatModerationProvider({
        serviceUrl: requireProviderEnv(
          "MODERATION_SERVICE_URL",
          env.MODERATION_SERVICE_URL,
          "MODERATION_PROVIDER",
          env.MODERATION_PROVIDER,
        ),
        apiKey: requireProviderEnv(
          "MODERATION_API_KEY",
          env.MODERATION_API_KEY,
          "MODERATION_PROVIDER",
          env.MODERATION_PROVIDER,
        ),
        timeoutMs: env.MODERATION_TIMEOUT_MS,
      });
    default:
      throw new Error(
        `MODERATION_PROVIDER=${env.MODERATION_PROVIDER} unsupported (use "mock" or "safety-gateway").`,
      );
  }
}

function requireProviderEnv(
  name: string,
  value: string | undefined,
  providerName: string,
  provider: string,
) {
  if (!value) throw new Error(`${name} is required when ${providerName}=${provider}`);
  return value;
}

// SPEC: refuse to boot the chat service on mock providers in production, mirroring
// the main/gen provider guards. INTENT: launch-readiness CLI already flags mock chat,
// but a deploy must also fail closed in-process so a misconfig can't quietly serve
// templated "Mock … reply" text or skip output moderation. INVARIANT: APP_ENV is the
// single production switch shared across services.
function assertProductionChatProvidersReady() {
  if (process.env.APP_ENV !== "production") return;

  const mockProviders = [
    ["CHAT_MODEL_PROVIDER", env.CHAT_MODEL_PROVIDER],
    ["MODERATION_PROVIDER", env.MODERATION_PROVIDER],
  ]
    .filter(([, provider]) => provider === "mock")
    .map(([name]) => name);

  if (mockProviders.length > 0) {
    throw new Error(
      `Production requires non-mock chat providers: ${mockProviders.join(", ")}`,
    );
  }
}

export function createProviders(): ChatProviders {
  assertProductionChatProvidersReady();
  const moderation = createModerationProvider();

  switch (env.CHAT_MODEL_PROVIDER) {
    case "mock":
      return { chat: new MockChatModel(), moderation };
    // "openai" = any OpenAI-compatible endpoint (oMLX / LM Studio / OpenAI).
    // "pipeline" is the production gateway alias; it exposes the same endpoint.
    case "openai":
      return {
        chat: new OpenAIChatModel(
          env.CHAT_MODEL_BASE_URL,
          env.CHAT_MODEL_NAME,
          env.CHAT_MODEL_API_KEY,
          true,
        ),
        moderation,
      };
    case "pipeline":
      return {
        chat: new OpenAIChatModel(
          env.CHAT_MODEL_BASE_URL,
          env.CHAT_MODEL_NAME,
          env.CHAT_MODEL_API_KEY,
          false,
        ),
        moderation,
      };
    default:
      throw new Error(
        `CHAT_MODEL_PROVIDER=${env.CHAT_MODEL_PROVIDER} unsupported (use "mock", "openai", or "pipeline").`,
      );
  }
}

export const providers = createProviders();

function chatCompletionEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.pathname.endsWith("/chat/completions")) return url;
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/chat/completions`;
  return url;
}
