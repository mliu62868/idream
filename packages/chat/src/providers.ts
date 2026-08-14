// SPEC: Chat service only needs two providers — the chat model (streaming) and
// moderation (input/output). Slim, self-contained; no image/video/payment/blob.
// INTENT: keep the chat deploy artifact thin (design §10 dependency isolation).
import {
  SafetyGatewayModerationProvider,
  OpenAICompatibleChatModel,
  resolveChatModelProfile,
  type ChatModelProfile,
} from "@idream/shared";
import { env } from "./env.js";
import { logger } from "./logger.js";

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
    characterName?: string;
    tools?: ChatToolDefinition[];
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

// SPEC: dev/test seam — the last messages array MockChatModel.stream received,
// so integration tests can assert what generate.ts actually sent to the model
// (e.g. the P4 Task 5 photo-awareness context line) without a real provider.
let lastMockStreamMessages: ModelMessage[] | null = null;
export function getLastMockStreamMessages(): ModelMessage[] | null {
  return lastMockStreamMessages;
}

class MockChatModel implements ChatModel {
  // SPEC: dev/test seam so P4 tests can exercise the "FC unavailable" fallback
  // path (planner) against a mock provider without a real pipeline model.
  get supportsTools(): boolean {
    return process.env.CHAT_MOCK_SUPPORTS_TOOLS !== "false";
  }

  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    lastMockStreamMessages = input.messages;
    if (process.env.CHAT_MOCK_EMPTY_RESPONSE === "true") {
      yield { delta: "", done: true, toolCalls: [] };
      return;
    }
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
    logger.warn({ err: error }, "CHAT_MOCK_TOOL_CALLS_JSON is not valid JSON; ignoring");
    return [];
  }
}

// SPEC: stream from any OpenAI-compatible /chat/completions endpoint (SSE).
// Local default targets oMLX (Apple-Silicon mlx server) on :8061 with a Qwen
// model — see packages/chat/.env. INVARIANT: yields only assistant `content`
// deltas; a reasoning model's `reasoning_content` is dropped so thinking never
// leaks into the reply. EXAMPLE: provider=openai, model=Qwen3.5-4B-MLX-4bit.
export class OpenAIChatModel extends OpenAICompatibleChatModel implements ChatModel {}

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

// INVARIANT: keep-first on id/name — some providers repeat the id/name on every
// fragment at an index rather than only the first, and a differing repeat must
// not clobber the value the earlier fragment already established.
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

// SPEC: refuse to boot the chat service on a mock model in production, mirroring
// the main/gen provider guards. INTENT: launch-readiness CLI already flags mock chat,
// but a deploy must also fail closed in-process so a misconfig can't quietly serve
// templated "Mock … reply" text. Moderation mock is an intentional production mode.
// INVARIANT: APP_ENV is the single production switch shared across services.
function assertProductionChatProvidersReady() {
  if (process.env.APP_ENV !== "production") return;
  if (env.CHAT_MODEL_PROVIDER === "mock") {
    throw new Error(
      "Production requires non-mock chat providers: CHAT_MODEL_PROVIDER",
    );
  }
}

// "openai" and "pipeline" both target an OpenAI-compatible endpoint (oMLX / LM
// Studio / OpenAI, or the production gateway alias) and differ only in whether
// function-calling ("openai") or not ("pipeline", not yet exposed) is supported.
function createOpenAICompatibleChatModel(supportsTools: boolean): OpenAIChatModel {
  const profile = resolveChatModelProfile(process.env);
  return new OpenAIChatModel({ ...profile, supportsTools });
}

export function createProviders(): ChatProviders {
  assertProductionChatProvidersReady();
  const moderation = createModerationProvider();

  switch (env.CHAT_MODEL_PROVIDER) {
    case "mock":
      return { chat: new MockChatModel(), moderation };
    case "openai":
      return { chat: createOpenAICompatibleChatModel(true), moderation };
    case "pipeline":
      return { chat: createOpenAICompatibleChatModel(false), moderation };
    default:
      throw new Error(
        `CHAT_MODEL_PROVIDER=${env.CHAT_MODEL_PROVIDER} unsupported (use "mock", "openai", or "pipeline").`,
      );
  }
}

let resolvedProviders: ChatProviders | null = null;
export const providers = new Proxy({} as ChatProviders, {
  get(_target, property: keyof ChatProviders) {
    resolvedProviders ??= createProviders();
    return resolvedProviders[property];
  },
});
