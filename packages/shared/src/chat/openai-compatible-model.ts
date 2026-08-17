import { pipelineEndpoint } from "../contracts/env";
import type { ChatModelProfile } from "./model-profile";

export interface ChatChunk {
  delta: string;
  done: boolean;
  toolCalls?: ChatToolCall[];
  /**
   * Real provider token counts, carried on the final (done) chunk when the
   * provider reports usage. Absent otherwise — callers estimate instead.
   */
  usage?: ChatUsage;
}

export type ChatUsage = { promptTokens: number; completionTokens: number };

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

export class ChatModelOutputLimitError extends Error {
  readonly code = "chat_model_output_limit";

  constructor(readonly maxTokens: number) {
    super(`Chat model stopped at the max output token limit (${maxTokens})`);
    this.name = "ChatModelOutputLimitError";
  }
}

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
          temperature: this.profile.temperature,
          top_p: this.profile.topP,
          repetition_penalty: this.profile.repetitionPenalty,
          // INTENT: only source of real token counts — without it the caller can
          // only estimate from characters, which badly undercounts CJK.
          stream_options: { include_usage: true },
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
      let usage: ChatUsage | undefined;
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
            yield { delta: "", done: true, toolCalls: flattenToolCalls(toolCallsByIndex), usage };
            return;
          }
          // INVARIANT: the usage-bearing chunk carries an empty `choices`, so it
          // must not short-circuit the delta path — it arrives after the last one.
          const event = JSON.parse(payload) as { choices?: unknown[]; usage?: unknown };
          usage = readUsage(event.usage) ?? usage;
          const choice = (event.choices?.[0] ?? {}) as {
            finish_reason?: unknown;
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          };
          const delta = choice.delta ?? {};
          const hasToolOutput = delta.tool_calls?.some((fragment) => Boolean(
            fragment.id || fragment.function?.name || fragment.function?.arguments,
          )) ?? false;
          if ((delta.content?.length ?? 0) > 0 || hasToolOutput) armIdleTimeout();
          accumulateToolCalls(toolCallsByIndex, delta.tool_calls);
          if (delta.content) yield { delta: delta.content, done: false };
          assertOutputWasComplete(choice.finish_reason, this.profile.maxOutputTokens);
        }
      }
      yield { delta: "", done: true, toolCalls: flattenToolCalls(toolCallsByIndex), usage };
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
    const maxTokens = input.maxTokens ?? Math.min(this.profile.maxOutputTokens, 1_400);
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
          max_tokens: maxTokens,
          // INTENT: this path plans tools and extracts JSON, so it wants the
          // schema obeyed, not personality — no top_p/repetition_penalty either,
          // both of which fight the repeated punctuation JSON legitimately needs.
          temperature: this.profile.structuredTemperature,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!response.ok) {
        throw new Error(`Chat model HTTP ${response.status}: ${await response.text().catch(() => "")}`);
      }
      const data = await response.json() as {
        choices?: Array<{
          finish_reason?: unknown;
          message?: { content?: unknown };
        }>;
      };
      const choice = data.choices?.[0];
      assertOutputWasComplete(choice?.finish_reason, maxTokens);
      const content = choice?.message?.content;
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

function readUsage(raw: unknown): ChatUsage | undefined {
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined;
  const promptTokens = usage?.prompt_tokens;
  const completionTokens = usage?.completion_tokens;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return undefined;
  return { promptTokens, completionTokens };
}

function assertOutputWasComplete(finishReason: unknown, maxTokens: number): void {
  if (finishReason === "length") throw new ChatModelOutputLimitError(maxTokens);
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
