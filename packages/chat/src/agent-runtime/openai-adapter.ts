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
import { isOpenRouterBaseUrl } from "@idream/shared";
import { parseImageAgentToolCall } from "@idream/shared/chat/image-action";
import { createHash } from "node:crypto";
import { logger } from "../logger.js";
import type { CompanionModelRequestEvidence, CompanionToolCall, PreparedTurnProfile } from "./contracts";
import { estimateModelRequestInputTokens, formatModelRequestInput, type ModelInputMessage } from "./model-request-format";

export interface OpenAiCompatibleAdapterOptions {
  profile: PreparedTurnProfile;
  apiKey: string;
  openRouterProviderOnly?: readonly string[];
  requiredToolName?: CompanionToolCall["name"];
  maxInputTokens?: number;
  /** Factual turns use the profile's structured temperature without changing the configured roleplay default. */
  samplingTemperature?: number;
  observeRequest?: (evidence: CompanionModelRequestEvidence) => void;
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
const REQUIRED_TOOL_OMITTED_MESSAGE = "provider omitted the required companion tool call";

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

function modelInputMessages(system: string | undefined, messages: readonly Message[]): ModelInputMessage[] {
  const output: ModelInputMessage[] = [];
  if (system) output.push({ id: "system", sourceKind: "plugin", role: "system", content: system });
  for (const message of messages) {
    const sourceKind = message.source.kind === "user" ? "current_user"
      : message.source.kind === "plugin" && "form" in message.source
        && ["snapshot", "recall", "context"].includes(String(message.source.form))
        ? "plugin" : "replay";
    const toolResult = message.content.find(
      (block): block is Extract<ContentBlock, { type: "tool-result" }> => block.type === "tool-result",
    );
    if (toolResult) {
      output.push({
        id: String(message.id),
        sourceKind,
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
        type: "function" as const,
        function: { name: block.name, arguments: block.arguments },
      }));
    const content = textOf(message.content);
    output.push({
      id: String(message.id),
      sourceKind,
      role: message.role,
      toolSource: message.source.kind === "tool",
      content,
      ...(message.role === "assistant" && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return output;
}

function requiredToolArgumentsJson(
  name: CompanionToolCall["name"],
  content: string,
): string | null {
  let candidate = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(candidate);
  if (fenced) candidate = fenced[1] ?? "";
  try {
    const parsed = JSON.parse(candidate) as unknown;
    let raw = parsed;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>;
      if (row.name === name && row.arguments !== undefined) raw = row.arguments;
      const fn = row.function && typeof row.function === "object" && !Array.isArray(row.function)
        ? row.function as Record<string, unknown>
        : null;
      if (fn?.name === name && fn.arguments !== undefined) raw = fn.arguments;
    }
    if (typeof raw === "string") raw = JSON.parse(raw) as unknown;
    const toolCall = parseImageAgentToolCall(name, raw);
    return toolCall ? JSON.stringify(toolCall.arguments) : null;
  } catch {
    return null;
  }
}

function requiredToolOnlyChunks(
  chunks: readonly StreamChunk[],
  name: CompanionToolCall["name"],
): StreamChunk[] {
  const toolIndexes = new Set(chunks.flatMap((chunk) =>
    chunk.type === "block-end"
      && chunk.block.type === "tool-call"
      && chunk.block.name === name
      ? [chunk.index]
      : []));
  return chunks.filter((chunk) => {
    if (chunk.type === "usage" || chunk.type === "finish") return true;
    return toolIndexes.has(chunk.index);
  });
}

class RequiredToolOmission extends LlmError {
  constructor(
    readonly replayState: Extract<StreamChunk, { type: "finish" }>["replayState"],
    readonly finishReason: FinishReason,
  ) {
    super(REQUIRED_TOOL_OMITTED_MESSAGE, "INVALID_RESPONSE");
  }
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

function linkedSignal(source: AbortSignal | undefined): {
  signal: AbortSignal;
  abort(reason: Error): void;
  resetIdle(ms: number): void;
  clear(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(source?.reason ?? new Error("model request aborted"));
  if (source?.aborted) abort();
  else source?.addEventListener("abort", abort, { once: true });
  let idle: NodeJS.Timeout | undefined;
  return {
    signal: controller.signal,
    abort(reason) {
      controller.abort(reason);
    },
    resetIdle(ms) {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(
        new LlmError("model stream idle timeout", "MODEL_IDLE_TIMEOUT"),
      ), ms);
    },
    clear() {
      if (idle) clearTimeout(idle);
      source?.removeEventListener("abort", abort);
    },
  };
}

async function* decodedResponseChunks(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readDecodedChunk(reader, signal);
      if (done) break;
      if (value) yield value;
    }
    completed = true;
  } finally {
    if (!completed) {
      // INTENT: a provider-body cancellation is best-effort cleanup. Some
      // Bun fetch streams never settle reader.cancel() after headers, so the
      // timeout path must not await that transport-specific promise.
      void reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // The abandoned read owns the lock until cancellation settles.
    }
  }
}

function readDecodedChunk(
  reader: ReadableStreamDefaultReader<string>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<string>["read"]> {
  if (signal.aborted) return Promise.reject(modelAbortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(modelAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function modelAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

export class OpenAiCompatibleAdapter extends LlmAdapter {
  private readonly profile: PreparedTurnProfile;
  private readonly apiKey: string;
  private readonly providerOnly: readonly string[] | undefined;
  private readonly openRouter: boolean;
  private readonly request: typeof globalThis.fetch;
  private readonly requiredToolName: CompanionToolCall["name"] | undefined;
  private requiredToolCompleted: boolean;
  private readonly maxInputTokens: number | undefined;
  private readonly samplingTemperature: number | undefined;
  private readonly observeRequest: OpenAiCompatibleAdapterOptions["observeRequest"];

  constructor(options: OpenAiCompatibleAdapterOptions) {
    super();
    this.profile = options.profile;
    this.apiKey = options.apiKey.trim();
    this.providerOnly = options.openRouterProviderOnly?.map((value) => value.trim()).filter(Boolean);
    this.openRouter = isOpenRouterBaseUrl(this.profile.baseUrl);
    this.request = options.fetch ?? globalThis.fetch;
    this.requiredToolName = options.requiredToolName;
    this.maxInputTokens = options.maxInputTokens;
    this.samplingTemperature = options.samplingTemperature;
    this.observeRequest = options.observeRequest;
    this.requiredToolCompleted = !options.requiredToolName;
    if (!this.apiKey) throw new Error("OpenAI-compatible API key is required");
    if (this.openRouter && !this.providerOnly?.length) {
      throw new Error("OpenRouter requires an exact DSH_OPENROUTER_PROVIDER_ONLY pin");
    }
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal) {
    if (provider !== this.profile.provider || model !== this.profile.model) {
      throw new Error("model route differs from the pinned invocation profile");
    }
    return Promise.resolve({ provider, id: model, name: model });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.requiredToolCompleted || !this.requiredToolName) {
      yield* this.streamOnce(options);
      return;
    }

    let omission: unknown;
    let totalUsage: TokenUsage | undefined;
    for (const jsonCompatibilityMode of [false, true]) {
      const chunks: StreamChunk[] = [];
      try {
        for await (const chunk of this.streamOnce(options, jsonCompatibilityMode)) {
          if (chunk.type === "usage") {
            totalUsage = {
              inputTokens: (totalUsage?.inputTokens ?? 0) + (chunk.usage.inputTokens ?? 0),
              outputTokens: (totalUsage?.outputTokens ?? 0) + (chunk.usage.outputTokens ?? 0),
              cacheReadTokens: (totalUsage?.cacheReadTokens ?? 0) + (chunk.usage.cacheReadTokens ?? 0),
              cacheWriteTokens: (totalUsage?.cacheWriteTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
              reasoningTokens: (totalUsage?.reasoningTokens ?? 0) + (chunk.usage.reasoningTokens ?? 0),
            };
          } else chunks.push(chunk);
        }
        for (const chunk of requiredToolOnlyChunks(chunks, this.requiredToolName)) {
          if (chunk.type === "finish" && totalUsage) yield { type: "usage", usage: totalUsage };
          yield chunk;
        }
        return;
      } catch (error) {
        if (!(error instanceof RequiredToolOmission)) throw error;
        omission = error;
        const content = chunks
          .filter((chunk): chunk is Extract<StreamChunk, { type: "text-delta" }> =>
            chunk.type === "text-delta")
          .map((chunk) => chunk.text)
          .join("");
        // Some compatible providers return the exact arguments as text even
        // for a forced native tool. Validate that completed candidate before
        // spending another request; length-limited or mixed tool output is not
        // an alternative complete action, even if its text happens to parse.
        const argumentsJson = error.finishReason.kind === "stop"
          && !chunks.some((chunk) => chunk.type === "tool-call-delta")
          ? requiredToolArgumentsJson(this.requiredToolName, content)
          : null;
        if (!argumentsJson) {
          if (!jsonCompatibilityMode) continue;
          break;
        }
        const callId = `compat_${createHash("sha256")
          .update(`${this.requiredToolName}\0${argumentsJson}`)
          .digest("hex")
          .slice(0, 24)}` as never;
        this.requiredToolCompleted = true;
        logger.info({
          event: "companion_required_tool_json_compatibility",
          requiredToolName: this.requiredToolName,
        }, "converted validated provider JSON into a companion tool call");
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: 0,
          id: callId,
          name: this.requiredToolName,
          argumentsDelta: argumentsJson,
        };
        yield {
          type: "block-end",
          index: 0,
          block: {
            type: "tool-call",
            id: callId,
            name: this.requiredToolName,
            arguments: argumentsJson,
          },
        };
        if (totalUsage) yield { type: "usage", usage: totalUsage };
        yield { type: "finish", reason: { kind: "tool-calls" }, replayState: error.replayState };
        return;
      }
    }
    throw omission;
  }

  private async *streamOnce(
    options: GenerateOptions,
    jsonCompatibilityMode = false,
  ): AsyncIterable<StreamChunk> {
    if (options.provider !== this.profile.provider || options.model !== this.profile.model) {
      throw new LlmError("model route differs from the pinned invocation profile", "INVALID_ROUTE");
    }
    const forceRequiredTool = !this.requiredToolCompleted;
    if (
      forceRequiredTool &&
      !options.tools?.some((tool) => tool.name === this.requiredToolName)
    ) {
      throw new LlmError("required image tool is absent from the model request", "INVALID_ROUTE");
    }
    const timeout = linkedSignal(options.signal);
    let firstToken = true;
    const firstTokenTimer = setTimeout(
      () => timeout.abort(new LlmError(
        "model first-token timeout",
        "MODEL_FIRST_TOKEN_TIMEOUT",
      )),
      this.profile.timeout.firstTokenMs,
    );
    const modelInput = formatModelRequestInput({
      messages: modelInputMessages(options.system, options.messages),
      tools: options.tools,
      requiredTool: forceRequiredTool,
      jsonCompatibilityMode,
    });
    const body = {
      model: options.model,
      // SPEC: the latest user request authorizes one image action. Preserve
      // prepared Scene, dialogue and recall as quoted continuity evidence;
      // earlier requests and tool protocol cannot become new actions. Chat
      // confirms the request locally only after Main accepts the effect.
      messages: modelInput.messages,
      stream: true,
      stream_options: { include_usage: true },
      // INTENT: one sampling profile for the whole streamed turn. DSH always
      // exposes memory tools in normal mode, so a "structured" temperature
      // keyed on `tools.length` would flatten every companion reply to the
      // planner setting (0.2) — the voice must not depend on tool exposure.
      temperature: jsonCompatibilityMode
        ? 0
        : this.samplingTemperature ?? this.profile.sampling.temperature,
      top_p: this.profile.sampling.topP,
      repetition_penalty: this.profile.sampling.repetitionPenalty,
      // A response-length preference must not truncate native/JSON tool arguments.
      // The required visual direction step retains its original model budget.
      max_tokens: Math.min(
        options.maxTokens ?? this.profile.maxOutputTokens,
        this.profile.maxOutputTokens,
        forceRequiredTool ? this.profile.maxOutputTokens : this.profile.answerMaxOutputTokens ?? this.profile.maxOutputTokens,
      ),
      // INVARIANT: Chat-owned PreparedTurn budgets the companion reply, not
      // hidden chain-of-thought inside the sole DSH execution path.
      chat_template_kwargs: { enable_thinking: false },
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? {
        tools: modelInput.tools,
        // SPEC: OpenAI-compatible servers must enter the native function-call
        // path when tools are present; never rely on a server-specific default
        // that may render a tool plan as ordinary assistant JSON.
        tool_choice: forceRequiredTool
          ? {
              type: "function",
              function: { name: this.requiredToolName },
            }
          : "auto",
      } : {}),
      ...(this.openRouter ? {
        provider: { only: [...(this.providerOnly ?? [])], allow_fallbacks: false },
      } : {}),
    };
    if (forceRequiredTool) {
      logger.info({
        event: "companion_required_tool_forced",
        requiredToolName: this.requiredToolName,
        offeredToolNames: options.tools?.map((tool) => tool.name) ?? [],
      }, "forcing required companion tool");
    }

    try {
      // Apply the same character estimate as PreparedTurn, now
      // including DSH guidance, resident memory, tool results and wire schemas.
      // This is an input estimate, not a claim about a provider's tokenizer.
      const estimatedInputTokens = estimateModelRequestInputTokens(body);
      if (this.maxInputTokens !== undefined && estimatedInputTokens > this.maxInputTokens) {
        throw new LlmError("assembled model request exceeds the prepared input budget", "INPUT_BUDGET_EXCEEDED");
      }
      const serializedBody = JSON.stringify(body);
      this.observeRequest?.({
        bodyDigest: createHash("sha256").update(serializedBody).digest("hex"),
        systemPromptDigest: createHash("sha256").update(body.messages
          .filter((message): message is { role: "system"; content: string } =>
            message !== null && typeof message === "object"
            && "role" in message && message.role === "system"
            && "content" in message && typeof message.content === "string")
          .map(message => message.content)
          .join("\n")).digest("hex"),
        estimatedInputTokens,
        ...(this.maxInputTokens === undefined ? {} : { maxInputTokens: this.maxInputTokens }),
      });
      const response = await this.request(chatCompletionsUrl(this.profile.baseUrl), {
        method: "POST",
        headers: {
          ...attributionHeaders(),
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: serializedBody,
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

      for await (const text of decodedResponseChunks(response.body, timeout.signal)) {
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
            || (chunk.type === "tool-call-delta" && Boolean(chunk.name || chunk.argumentsDelta)))) {
            if (firstToken) clearTimeout(firstTokenTimer);
            firstToken = false;
            // Prefill owns its full first-token deadline. Once output starts,
            // only model output renews the idle deadline; socket bytes, SSE
            // comments and empty metadata cannot disguise a stalled model.
            timeout.resetIdle(this.profile.timeout.idleMs);
          }
          for (const chunk of chunks) yield chunk;
        }
        if (Buffer.byteLength(buffer) > MAX_PROVIDER_EVENT_BYTES) {
          failStreamLimit("provider SSE event exceeded the configured byte limit");
        }
      }

      if (!nativeFinish) {
        throw new LlmError("provider stream ended without a finish reason", "INVALID_RESPONSE");
      }
      const resolvedFinish = finishReason(nativeFinish);
      // Attribution belongs to the actual provider response, including a JSON
      // compatibility completion. Validate it before accepting either path.
      if (this.openRouter) {
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
      const replayState = {
        response: {
          ...(responseId ? { id: responseId } : {}),
          ...(actualProvider ? { provider: actualProvider } : {}),
        },
      };
      // A completed request spent tokens even if it omitted its required tool.
      // The compatibility wrapper accounts for both requests before returning
      // one validated DSH completion anchor.
      if (usage) yield { type: "usage", usage };
      if (forceRequiredTool) {
        const requiredToolObserved = [...blocks.values()].some(
          (state) => state.type === "tool-call" && state.name === this.requiredToolName,
        );
        if (resolvedFinish.kind !== "tool-calls" || !requiredToolObserved) {
          logger.warn({
            event: "companion_required_tool_omitted",
            requiredToolName: this.requiredToolName,
            finishReason: resolvedFinish.kind,
            observedToolNames: [...blocks.values()]
              .filter((state) => state.type === "tool-call")
              .map((state) => state.name)
              .filter(Boolean),
          }, "provider omitted required companion tool");
          throw new RequiredToolOmission(replayState, resolvedFinish);
        }
        // INVARIANT: transport retries and abandoned streams must keep forcing
        // the action. Only a validated native tool call advances the adapter to
        // the post-tool conversational step.
        this.requiredToolCompleted = true;
        logger.info({
          event: "companion_required_tool_observed",
          requiredToolName: this.requiredToolName,
          responseId,
        }, "provider returned required companion tool");
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
      yield {
        type: "finish",
        reason: resolvedFinish,
        replayState,
      };
    } finally {
      clearTimeout(firstTokenTimer);
      timeout.clear();
    }
  }
}
