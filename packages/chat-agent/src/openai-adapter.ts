import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import type { PreparedTurnProfile } from "@idream/shared/chat/companion-runtime";

export interface OpenAiCompatibleAdapterOptions {
  profile: PreparedTurnProfile;
  apiKey: string;
  openRouterProviderOnly?: readonly string[];
  fetch?: typeof globalThis.fetch;
}

interface OpenAiStreamPayload {
  id?: string;
  provider?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface BlockState {
  index: number;
  type: "text" | "reasoning" | "tool-call";
  text: string;
  id?: string;
  name?: string;
}

const MAX_PROVIDER_STREAM_BYTES = 4_194_304;
const MAX_PROVIDER_EVENT_BYTES = 1_048_576;
const MAX_PROVIDER_OUTPUT_BYTES = 2_097_152;

function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url.toString();
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function openAiMessages(system: string | undefined, messages: readonly Message[]): unknown[] {
  const output: unknown[] = [];
  if (system) output.push({ role: "system", content: system });
  for (const message of messages) {
    const toolResult = message.content.find(
      (block): block is Extract<ContentBlock, { type: "tool-result" }> => block.type === "tool-result",
    );
    if (toolResult) {
      output.push({
        role: "tool",
        tool_call_id: String(toolResult.toolCallId),
        content: textOf(toolResult.content),
      });
      continue;
    }
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: "tool-call" }> => block.type === "tool-call")
      .map((block) => ({
        id: String(block.id),
        type: "function",
        function: { name: block.name, arguments: block.arguments },
      }));
    const content = textOf(message.content);
    output.push({
      role: message.role,
      content: content || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return output;
}

function finishReason(value: string | undefined): FinishReason {
  switch (value) {
    case "stop":
      return { kind: "stop" };
    case "length":
      return { kind: "max-tokens" };
    case "tool_calls":
    case "function_call":
      return { kind: "tool-calls" };
    default:
      throw new LlmError(
        `provider returned unsupported finish_reason ${String(value)}`,
        "INVALID_RESPONSE",
      );
  }
}

function usageOf(payload: OpenAiStreamPayload): TokenUsage | undefined {
  if (!payload.usage) return undefined;
  const cachedTokens = Math.max(0, payload.usage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    inputTokens: Math.max(0, (payload.usage.prompt_tokens ?? 0) - cachedTokens),
    outputTokens: Math.max(0, payload.usage.completion_tokens ?? 0),
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
    reasoningTokens: Math.max(
      0,
      payload.usage.completion_tokens_details?.reasoning_tokens ?? 0,
    ),
  };
}

function fuseSignal(source: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  abort(reason: Error): void;
  resetIdle(ms: number): void;
  clear(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(source?.reason ?? new Error("model request aborted"));
  if (source?.aborted) abort();
  else source?.addEventListener("abort", abort, { once: true });
  const completion = setTimeout(
    () => controller.abort(new Error("model completion timeout")),
    timeoutMs,
  );
  let idle: NodeJS.Timeout | undefined;
  return {
    signal: controller.signal,
    abort(reason) {
      controller.abort(reason);
    },
    resetIdle(ms) {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new Error("model stream idle timeout")), ms);
    },
    clear() {
      clearTimeout(completion);
      if (idle) clearTimeout(idle);
      source?.removeEventListener("abort", abort);
    },
  };
}

export class OpenAiCompatibleAdapter extends LlmAdapter {
  private readonly profile: PreparedTurnProfile;
  private readonly apiKey: string;
  private readonly providerOnly: readonly string[] | undefined;
  private readonly request: typeof globalThis.fetch;

  constructor(options: OpenAiCompatibleAdapterOptions) {
    super();
    this.profile = options.profile;
    this.apiKey = options.apiKey.trim();
    this.providerOnly = options.openRouterProviderOnly?.map((value) => value.trim()).filter(Boolean);
    this.request = options.fetch ?? globalThis.fetch;
    if (!this.apiKey) throw new Error("OpenAI-compatible API key is required");
    if (this.profile.provider === "openrouter" && !this.providerOnly?.length) {
      throw new Error("OpenRouter requires an exact DSH_OPENROUTER_PROVIDER_ONLY pin");
    }
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal) {
    if (provider !== this.profile.provider || model !== this.profile.model) {
      throw new Error("model route differs from the pinned invocation profile");
    }
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== this.profile.provider || options.model !== this.profile.model) {
      throw new LlmError("model route differs from the pinned invocation profile", "INVALID_ROUTE");
    }
    const timeout = fuseSignal(options.signal, this.profile.timeout.completionMs);
    let firstToken = true;
    const firstTokenTimer = setTimeout(
      () => timeout.abort(new Error("model first-token timeout")),
      this.profile.timeout.firstTokenMs,
    );
    const body = {
      model: options.model,
      messages: openAiMessages(options.system, options.messages),
      stream: true,
      stream_options: { include_usage: true },
      // INTENT: DSH performs tool selection inside the streamed turn instead of
      // a separate planner request. Use the profile's schema-obedience sampling
      // whenever function schemas are exposed; plain dialogue keeps its voice.
      temperature: options.tools?.length
        ? this.profile.sampling.structuredTemperature
        : this.profile.sampling.temperature,
      top_p: this.profile.sampling.topP,
      repetition_penalty: this.profile.sampling.repetitionPenalty,
      max_tokens: options.maxTokens ?? this.profile.maxOutputTokens,
      // INVARIANT: the PreparedTurn output budget is for the companion reply,
      // not hidden chain-of-thought. Native Chat uses the same model contract.
      chat_template_kwargs: { enable_thinking: false },
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? {
        tools: options.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      } : {}),
      ...(this.profile.provider === "openrouter" ? {
        provider: { only: [...(this.providerOnly ?? [])], allow_fallbacks: false },
      } : {}),
    };

    try {
      const response = await this.request(chatCompletionsUrl(this.profile.baseUrl), {
        method: "POST",
        headers: {
          ...attributionHeaders(),
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new LlmError(
          `OpenAI-compatible provider returned HTTP ${response.status}`,
          "PROVIDER_HTTP_ERROR",
          { status: response.status },
        );
      }
      if (!response.body) throw new LlmError("provider response body is missing", "EMPTY_RESPONSE");

      const blocks = new Map<string, BlockState>();
      let nextIndex = 0;
      let buffer = "";
      let nativeFinish: string | undefined;
      let usage: TokenUsage | undefined;
      let responseId: string | undefined;
      let actualProvider: string | undefined;
      let responseBytes = 0;
      let outputBytes = 0;
      const failStreamLimit = (message: string): never => {
        const error = new LlmError(message, "PROVIDER_STREAM_LIMIT");
        timeout.abort(error);
        throw error;
      };
      const appendOutput = (state: BlockState, value: string): void => {
        outputBytes += Buffer.byteLength(value);
        if (outputBytes > MAX_PROVIDER_OUTPUT_BYTES) {
          failStreamLimit("provider output exceeded the configured byte limit");
        }
        state.text += value;
      };
      const ensure = (key: string, type: BlockState["type"], id?: string): [BlockState, StreamChunk[]] => {
        const existing = blocks.get(key);
        if (existing) return [existing, []];
        const state = { index: nextIndex++, type, text: "", ...(id ? { id } : {}) };
        blocks.set(key, state);
        return [state, [{ type: "block-start", index: state.index, blockType: type } as StreamChunk]];
      };
      const processPayload = (payload: OpenAiStreamPayload): StreamChunk[] => {
        const chunks: StreamChunk[] = [];
        responseId ??= payload.id;
        actualProvider ??= payload.provider;
        usage = usageOf(payload) ?? usage;
        const choice = payload.choices?.[0];
        nativeFinish = choice?.finish_reason ?? nativeFinish;
        const delta = choice?.delta;
        if (delta?.content) {
          const [state, start] = ensure("text", "text");
          chunks.push(...start);
          appendOutput(state, delta.content);
          chunks.push({ type: "text-delta", index: state.index, text: delta.content });
        }
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) {
          const [state, start] = ensure("reasoning", "reasoning");
          chunks.push(...start);
          appendOutput(state, reasoning);
          chunks.push({ type: "reasoning-delta", index: state.index, text: reasoning });
        }
        for (const call of delta?.tool_calls ?? []) {
          const providerIndex = call.index ?? 0;
          const [state, start] = ensure(`tool:${providerIndex}`, "tool-call", call.id);
          chunks.push(...start);
          state.id ??= call.id;
          state.name ??= call.function?.name;
          const argumentsDelta = call.function?.arguments ?? "";
          appendOutput(state, argumentsDelta);
          if (!state.id) throw new LlmError("provider tool call omitted its id", "INVALID_RESPONSE");
          chunks.push({
            type: "tool-call-delta",
            index: state.index,
            id: state.id as never,
            ...(call.function?.name ? { name: call.function.name } : {}),
            argumentsDelta,
          });
        }
        return chunks;
      };

      for await (const text of response.body.pipeThrough(new TextDecoderStream())) {
        timeout.resetIdle(this.profile.timeout.idleMs);
        responseBytes += Buffer.byteLength(text);
        if (responseBytes > MAX_PROVIDER_STREAM_BYTES) {
          failStreamLimit("provider stream exceeded the configured byte limit");
        }
        buffer += text;
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary || boundary.index === undefined) break;
          const event = buffer.slice(0, boundary.index);
          if (Buffer.byteLength(event) > MAX_PROVIDER_EVENT_BYTES) {
            failStreamLimit("provider SSE event exceeded the configured byte limit");
          }
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          const payload = JSON.parse(data) as OpenAiStreamPayload;
          const chunks = processPayload(payload);
          if (chunks.some((chunk) => chunk.type === "text-delta"
            || chunk.type === "reasoning-delta"
            || chunk.type === "tool-call-delta")) {
            if (firstToken) clearTimeout(firstTokenTimer);
            firstToken = false;
          }
          for (const chunk of chunks) yield chunk;
        }
        if (Buffer.byteLength(buffer) > MAX_PROVIDER_EVENT_BYTES) {
          failStreamLimit("provider SSE event exceeded the configured byte limit");
        }
      }

      for (const state of [...blocks.values()].sort((left, right) => left.index - right.index)) {
        const block: ContentBlock = state.type === "text"
          ? { type: "text", text: state.text }
          : state.type === "reasoning"
            ? { type: "reasoning", text: state.text }
            : {
                type: "tool-call",
                id: (state.id ?? "") as never,
                name: state.name ?? "",
                arguments: state.text,
              };
        yield { type: "block-end", index: state.index, block };
      }
      if (!nativeFinish) {
        throw new LlmError("provider stream ended without a finish reason", "INVALID_RESPONSE");
      }
      if (this.profile.provider === "openrouter") {
        if (!responseId || !actualProvider) {
          throw new LlmError("OpenRouter stream omitted request/provider attribution", "INVALID_RESPONSE");
        }
        const attributed = actualProvider.trim().toLocaleLowerCase();
        if (!this.providerOnly?.some((provider) => provider.toLocaleLowerCase() === attributed)) {
          throw new LlmError(
            `OpenRouter attributed the response to unpinned provider ${actualProvider}`,
            "INVALID_RESPONSE",
          );
        }
      }
      if (usage) yield { type: "usage", usage };
      yield {
        type: "finish",
        reason: finishReason(nativeFinish),
        replayState: {
          response: {
            ...(responseId ? { id: responseId } : {}),
            ...(actualProvider ? { provider: actualProvider } : {}),
          },
        },
      };
    } finally {
      clearTimeout(firstTokenTimer);
      timeout.clear();
    }
  }
}
