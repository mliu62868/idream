import { pipelineEndpoint } from "../contracts/env";
import type { ChatModelProfile } from "./model-profile";

export interface ChatChunk {
  delta: string;
  done: boolean;
  toolCalls?: ChatToolCall[];
}

export type ChatToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatToolCall = { id: string; name: string; arguments: string };

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatCompletion {
  content: string;
}

export interface OpenAICompatibleTurn {
  model?: string;
  messages: ModelMessage[];
  characterName?: string;
  tools?: ChatToolDefinition[];
}

export interface OpenAICompatibleChatModelContract {
  readonly supportsTools?: boolean;
  stream(input: OpenAICompatibleTurn): AsyncIterable<ChatChunk>;
  complete(input: OpenAICompatibleTurn & { maxTokens?: number }): Promise<ChatCompletion>;
}

type FetchLike = typeof fetch;

/**
 * SPEC: One deploy-neutral OpenAI-compatible adapter is shared by Chat and
 * readiness probes. Service packages must not import each other's source.
 */
export class OpenAICompatibleChatModel implements OpenAICompatibleChatModelContract {
  constructor(
    private readonly profile: ChatModelProfile,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get supportsTools(): boolean {
    return this.profile.supportsTools;
  }

  async *stream(input: OpenAICompatibleTurn): AsyncIterable<ChatChunk> {
    const model = input.model || this.profile.model;
    const controller = new AbortController();
    let timeoutPhase: "first_token" | "idle" = "first_token";
    let timeout = setTimeout(() => controller.abort(), this.profile.firstTokenTimeoutMs);
    const armIdleTimeout = () => {
      timeoutPhase = "idle";
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), this.profile.idleTimeoutMs);
    };

    try {
      const response = await this.fetchImpl(chatCompletionEndpoint(this.profile.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.profile.apiKey ? { Authorization: `Bearer ${this.profile.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: input.messages,
          stream: true,
          max_tokens: this.profile.maxOutputTokens,
          chat_template_kwargs: { enable_thinking: false },
          ...(input.tools?.length
            ? {
                tools: input.tools.map((tool) => ({
                  type: "function",
                  function: tool,
                })),
              }
            : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Chat model HTTP ${response.status}: ${await response.text().catch(() => "")}`);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const toolCallsByIndex = new Map<number, ChatToolCall>();
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
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
          const hasToolOutput = delta.tool_calls?.some((fragment) => Boolean(
            fragment.id || fragment.function?.name || fragment.function?.arguments,
          )) ?? false;
          if ((delta.content?.length ?? 0) > 0 || hasToolOutput) armIdleTimeout();
          accumulateToolCalls(toolCallsByIndex, delta.tool_calls);
          if (delta.content) yield { delta: delta.content, done: false };
        }
      }
      yield { delta: "", done: true, toolCalls: flattenToolCalls(toolCallsByIndex) };
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutMs = timeoutPhase === "first_token"
          ? this.profile.firstTokenTimeoutMs
          : this.profile.idleTimeoutMs;
        throw new Error(`Chat model ${timeoutPhase} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async complete(input: OpenAICompatibleTurn & { maxTokens?: number }): Promise<ChatCompletion> {
    const model = input.model || this.profile.model;
    const controller = new AbortController();
    const timeoutMs = this.profile.completionTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(chatCompletionEndpoint(this.profile.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.profile.apiKey ? { Authorization: `Bearer ${this.profile.apiKey}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: input.messages,
          stream: false,
          max_tokens: input.maxTokens ?? Math.min(this.profile.maxOutputTokens, 1_400),
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!response.ok) {
        throw new Error(`Chat model HTTP ${response.status}: ${await response.text().catch(() => "")}`);
      }
      const data = await response.json() as {
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

function chatCompletionEndpoint(baseUrl: string): URL {
  return pipelineEndpoint(baseUrl, "/chat/completions");
}

function accumulateToolCalls(
  byIndex: Map<number, ChatToolCall>,
  fragments: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }> | undefined,
): void {
  if (!fragments) return;
  for (const fragment of fragments) {
    const existing = byIndex.get(fragment.index) ?? { id: "", name: "", arguments: "" };
    byIndex.set(fragment.index, {
      id: existing.id || fragment.id || "",
      name: existing.name || fragment.function?.name || "",
      arguments: existing.arguments + (fragment.function?.arguments ?? ""),
    });
  }
}

function flattenToolCalls(byIndex: Map<number, ChatToolCall>): ChatToolCall[] {
  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
}
