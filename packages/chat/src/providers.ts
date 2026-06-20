// SPEC: Chat service only needs two providers — the chat model (streaming) and
// moderation (input/output). Slim, self-contained; no image/video/payment/blob.
// INTENT: keep the chat deploy artifact thin (design §10 dependency isolation).
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

export function createProviders(): ChatProviders {
  for (const [name, value] of [
    ["CHAT_MODEL_PROVIDER", env.CHAT_MODEL_PROVIDER],
    ["MODERATION_PROVIDER", env.MODERATION_PROVIDER],
  ] as const) {
    if (value !== "mock") {
      throw new Error(`Only mock providers are wired today. ${name}=${value} unsupported.`);
    }
  }
  return { chat: new MockChatModel(), moderation: new MockModerationProvider() };
}

export const providers = createProviders();
