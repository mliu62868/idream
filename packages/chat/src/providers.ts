// SPEC: Chat service only needs two providers — the chat model (streaming) and
// moderation (input/output). Slim, self-contained; no image/video/payment/blob.
// INTENT: keep the chat deploy artifact thin (design §10 dependency isolation).
import { SafetyGatewayModerationProvider } from "@idream/shared";
import { env } from "./env.js";

export interface ChatChunk {
  delta: string;
  done: boolean;
}

export interface ChatModel {
  stream(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    characterName?: string;
  }): AsyncIterable<ChatChunk>;
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
  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    const lastUser =
      [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const reply = `Mock ${input.characterName ?? "character"} reply: ${lastUser}`.trim();
    // chunk into a few deltas so SSE/seq logic is exercised
    for (const piece of chunk(reply, 24)) yield { delta: piece, done: false };
    yield { delta: "", done: true };
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
  ) {}

  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    const res = await fetch(chatCompletionEndpoint(this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, messages: input.messages, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Chat model HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      // SSE frames are separated by a blank line; events carry `data: <json>`.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          yield { delta: "", done: true };
          return;
        }
        const delta = (JSON.parse(payload).choices?.[0]?.delta?.content ?? "") as string;
        if (delta) yield { delta, done: false };
      }
    }
    yield { delta: "", done: true };
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

export function createProviders(): ChatProviders {
  const moderation = createModerationProvider();

  switch (env.CHAT_MODEL_PROVIDER) {
    case "mock":
      return { chat: new MockChatModel(), moderation };
    // "openai" = any OpenAI-compatible endpoint (oMLX / LM Studio / OpenAI).
    // "pipeline" is the production gateway alias; it exposes the same endpoint.
    case "openai":
    case "pipeline":
      return {
        chat: new OpenAIChatModel(
          env.CHAT_MODEL_BASE_URL,
          env.CHAT_MODEL_NAME,
          env.CHAT_MODEL_API_KEY,
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
