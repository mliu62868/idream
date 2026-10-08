import {
  LlmAdapter,
  LlmError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  attributionHeaders,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { isOpenRouterBaseUrl } from "@idream/shared";
import { EDIT_LAST_IMAGE_TOOL, GENERATE_IMAGE_ASYNC_TOOL } from "@idream/shared/chat/image-action";
import { createHash } from "node:crypto";
import type { CompanionModelRequestEvidence, PreparedTurnProfile } from "./contracts";
import { estimateModelRequestInputTokens, formatModelRequestInput, type ModelInputMessage } from "./model-request-format";

export interface OpenAiCompatibleAdapterOptions {
  profile: PreparedTurnProfile;
  apiKey: string;
  openRouterProviderOnly?: readonly string[];
  maxInputTokens?: number;
  /** Distinguishes Main-pinned historical user messages from the current request. */
  replayMessageIds?: readonly string[];
  /** Reproject immutable current Scene, preferences, recall and request after compaction. */
  turnContextMessages?: readonly ModelInputMessage[];
  /** Factual turns use the profile's structured temperature without changing the configured roleplay default. */
  samplingTemperature?: number;
  responseFormat?: { type: "json_schema"; json_schema: { name: string; strict: true; schema: Record<string, unknown> } };
  observeRequest?: (evidence: CompanionModelRequestEvidence) => void;
  /** Exactly one receipt per physical request, even when its output is rejected. */
  observeUsage?: (usage: TokenUsage | undefined) => void;
  fetch?: typeof globalThis.fetch;
}

interface OpenAiStreamPayload {
  id?: string;
  provider?: string;
  error?: unknown;
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
    input_tokens?: number;
    output_tokens?: number;
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

async function providerFailureCode(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader?.();
  if (!reader) return "PROVIDER_HTTP_ERROR";
  let body = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await readStreamChunk(reader, signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8_192) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    return isContextWindowExceededError(body) ? CONTEXT_WINDOW_EXCEEDED_CODE : "PROVIDER_HTTP_ERROR";
  } finally {
    // Releasing an error response must not wait for a provider's cleanup.
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* The cancelled read may still own its lock. */ }
  }
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function modelInputMessages(system: string | undefined, messages: readonly RequestMessage[], replayIds: ReadonlySet<string>): ModelInputMessage[] {
  // Loop-built requests carry the system prompt as system-role messages; only
  // one-shot callers use `system`. Empty system nodes send no prompt.
  const prompt = [system, ...messages.map((message) => message.role === "system" ? textOf(message.content) : "")]
    .filter(Boolean)
    .join("\n\n");
  const output: ModelInputMessage[] = [];
  if (prompt) output.push({ id: "system", sourceKind: "plugin", role: "system", content: prompt });
  for (const [index, message] of messages.entries()) {
    // INTENT: developer messages only announce tool additions/removals; this
    // route declares the complete tool list on every request instead.
    if (message.role === "system" || message.role === "developer") continue;
    if (!message.source) {
      output.push({ id: `input:${index}`, sourceKind: "current_user", role: "user", content: textOf(message.content) });
      continue;
    }
    const sourceKind = replayIds.has(String(message.id)) ? "replay"
      : message.source.kind === "user" ? "current_user"
      : message.source.kind === "compact-checkpoint" || message.source.kind === "plugin:igrep" ? "plugin"
      : message.source.kind === "idream" && message.source.context !== "replay" ? "plugin" : "replay";
    if (message.role === "tool") {
      output.push({
        id: String(message.id),
        sourceKind,
        role: "tool",
        tool_call_id: String(message.toolCallId),
        content: textOf(message.content),
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
      content,
      ...(message.role === "assistant" && message.source.speaker ? { speaker: message.source.speaker } : {}),
      ...(message.role === "assistant" && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return output;
}

function projectTurnContext(
  messages: ModelInputMessage[],
  context: readonly ModelInputMessage[],
  checkpoints: ReadonlySet<string>,
): ModelInputMessage[] {
  if (context.length === 0) return messages;
  const current = context.find(message => message.sourceKind === "current_user");
  const fixed = context.filter(message => message.sourceKind === "plugin");
  const fixedIds = new Set(fixed.map(message => message.id));
  const projected = messages.filter(message => !fixedIds.has(message.id));
  const currentIndex = projected.findIndex(message => message.id === current?.id);
  if (currentIndex >= 0) {
    projected.splice(currentIndex, 0, ...fixed);
  } else {
    // Overflow compaction may retain only a tool tail. The current request is
    // still Main-pinned authority, independent of a clipped handoff summary.
    const index = projected.findIndex(message => message.role !== "system" && !checkpoints.has(message.id));
    projected.splice(index < 0 ? projected.length : index, 0, ...fixed, ...(current ? [current] : []));
  }
  return projected;
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
  const promptTokens = payload.usage.prompt_tokens ?? payload.usage.input_tokens;
  const completionTokens = payload.usage.completion_tokens ?? payload.usage.output_tokens;
  // Missing counters are unknown: treating them as zero would reuse a spent budget.
  if (typeof promptTokens !== "number" || !Number.isSafeInteger(promptTokens) || promptTokens < 0
    || typeof completionTokens !== "number" || !Number.isSafeInteger(completionTokens) || completionTokens < 0) return undefined;
  const cachedTokens = payload.usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = payload.usage.completion_tokens_details?.reasoning_tokens ?? 0;
  // Detail counters are subsets of the measured totals. Invalid details must
  // not introduce NaN into downstream budget comparisons or invent a subtotal.
  if (!Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > promptTokens
    || !Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > completionTokens) return undefined;
  return {
    inputTokens: promptTokens - cachedTokens,
    outputTokens: completionTokens,
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
    reasoningTokens,
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
      const { done, value } = await readStreamChunk(reader, signal);
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

function readStreamChunk<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<T>["read"]> {
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
  private readonly maxInputTokens: number | undefined;
  private readonly replayMessageIds: ReadonlySet<string>;
  private readonly turnContextMessages: readonly ModelInputMessage[];
  private readonly samplingTemperature: number | undefined;
  private readonly responseFormat: OpenAiCompatibleAdapterOptions["responseFormat"];
  private readonly observeRequest: OpenAiCompatibleAdapterOptions["observeRequest"];
  private readonly observeUsage: OpenAiCompatibleAdapterOptions["observeUsage"];

  constructor(options: OpenAiCompatibleAdapterOptions) {
    super();
    this.profile = options.profile;
    this.apiKey = options.apiKey.trim();
    this.providerOnly = options.openRouterProviderOnly?.map((value) => value.trim()).filter(Boolean);
    this.openRouter = isOpenRouterBaseUrl(this.profile.baseUrl);
    this.request = options.fetch ?? globalThis.fetch;
    this.turnContextMessages = options.turnContextMessages ?? [];
    this.maxInputTokens = options.maxInputTokens;
    this.replayMessageIds = new Set(options.replayMessageIds);
    this.samplingTemperature = options.samplingTemperature;
    this.responseFormat = options.responseFormat;
    this.observeRequest = options.observeRequest;
    this.observeUsage = options.observeUsage;
    if (!this.apiKey) throw new Error("OpenAI-compatible API key is required");
    if (this.openRouter && !this.providerOnly?.length) {
      throw new Error("OpenRouter requires an exact DSH_OPENROUTER_PROVIDER_ONLY pin");
    }
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal) {
    if (provider !== this.profile.provider || model !== this.profile.model) {
      throw new Error("model route differs from the pinned invocation profile");
    }
    return Promise.resolve({ provider, id: model, name: model,
      // Host-admitted capacity lets DSH pressure policy share the wire budget.
      ...(this.maxInputTokens === undefined ? {} : { context: { contextWindow: this.maxInputTokens + this.profile.maxOutputTokens } }),
      defaultMaxTokens: this.profile.maxOutputTokens,
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== this.profile.provider || options.model !== this.profile.model) {
      throw new LlmError("model route differs from the pinned invocation profile", "INVALID_ROUTE");
    }
    const compacting = options.purpose === "compaction";
    const imageToolsAvailable = options.tools?.some(tool =>
      tool.name === GENERATE_IMAGE_ASYNC_TOOL || tool.name === EDIT_LAST_IMAGE_TOOL);
    const timeout = linkedSignal(options.signal);
    let firstToken = true;
    const firstTokenTimer = setTimeout(
      () => timeout.abort(new LlmError(
        "model first-token timeout",
        "MODEL_FIRST_TOKEN_TIMEOUT",
      )),
      this.profile.timeout.firstTokenMs,
    );
    const surfaceMessages = modelInputMessages(options.system, options.messages, this.replayMessageIds);
    const inputMessages = compacting ? surfaceMessages : projectTurnContext(
      surfaceMessages,
      this.turnContextMessages,
      new Set(options.messages.filter(message => message.source?.kind === "compact-checkpoint").map(message => String(message.id))),
    );
    const modelInput = formatModelRequestInput({
      messages: inputMessages,
      tools: options.tools,
    });
    const currentUserIndex = inputMessages.findLastIndex(message => message.sourceKind === "current_user");
    const imageToolAlreadyCalled = inputMessages.slice(currentUserIndex + 1).some(message =>
      message.role === "assistant" && !this.replayMessageIds.has(message.id) && message.tool_calls?.some(call =>
        call.function.name === GENERATE_IMAGE_ASYNC_TOOL || call.function.name === EDIT_LAST_IMAGE_TOOL));
    const body = {
      model: options.model,
      // Preserve native dialogue and tool results. The Agent interprets the
      // current request; replay and recall provide continuity, not new actions.
      messages: modelInput.messages,
      stream: true,
      stream_options: { include_usage: true },
      // INTENT: one sampling profile for the whole streamed turn. DSH always
      // exposes memory tools in normal mode, so a "structured" temperature
      // keyed on `tools.length` would flatten every companion reply to the
      // planner setting (0.2) — the voice must not depend on tool exposure.
      temperature: compacting
        ? 0
        : this.samplingTemperature ?? this.profile.sampling.temperature,
      top_p: this.profile.sampling.topP,
      repetition_penalty: this.profile.sampling.repetitionPenalty,
      // A short-reply preference must not truncate a native image direction.
      // Tool availability reserves that budget without deciding whether to call.
      // The native API shares one limit for text and arguments, so first-step
      // text also has this ceiling; the short preference is then prompt-only.
      max_tokens: compacting ? options.maxTokens ?? this.profile.maxOutputTokens : Math.min(
        options.maxTokens ?? this.profile.maxOutputTokens,
        this.profile.maxOutputTokens,
        imageToolsAvailable && !imageToolAlreadyCalled ? this.profile.maxOutputTokens : this.profile.answerMaxOutputTokens ?? this.profile.maxOutputTokens,
      ),
      // INVARIANT: Chat-owned PreparedTurn budgets the companion reply, not
      // hidden chain-of-thought inside the sole DSH execution path.
      chat_template_kwargs: { enable_thinking: false },
      ...(this.responseFormat ? { response_format: this.responseFormat } : {}),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(options.tools?.length ? {
        tools: modelInput.tools,
        // SPEC: OpenAI-compatible servers must enter the native function-call
        // path when tools are present; never rely on a server-specific default
        // that may render a tool plan as ordinary assistant JSON.
        tool_choice: compacting ? "none" : "auto",
      } : {}),
      ...(this.openRouter ? {
        provider: { only: [...(this.providerOnly ?? [])], allow_fallbacks: false },
      } : {}),
    };
    let requestStarted = false;
    let usage: TokenUsage | undefined;
    try {
      // Apply the same character estimate as PreparedTurn, now
      // including DSH guidance, resident memory, tool results and wire schemas.
      // This is an input estimate, not a claim about a provider's tokenizer.
      const estimate = () => estimateModelRequestInputTokens(body)
        + (this.responseFormat ? Math.ceil(JSON.stringify(this.responseFormat).length / 4) : 0);
      const estimatedInputTokens = estimate();
      // Surface replacement must happen in DSH so originals remain recallable.
      // Auxiliary summaries read the bounded authorized snapshot; only the
      // resulting conversational request is charged to the admitted tier window.
      if (!compacting && this.maxInputTokens !== undefined && estimatedInputTokens > this.maxInputTokens) {
        throw new LlmError("assembled model request exceeds the prepared input budget",
          this.responseFormat ? "INPUT_BUDGET_EXCEEDED" : CONTEXT_WINDOW_EXCEEDED_CODE);
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
        ...(compacting ? { purpose: "compaction" as const } : this.maxInputTokens === undefined ? {} : { maxInputTokens: this.maxInputTokens }),
      });
      requestStarted = true;
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
      }).catch((error: unknown) => {
        // SPEC: a request that never reached the provider (ECONNREFUSED, DNS,
        // reset) is the dsh-llm TRANSPORT class. Our own timeouts and cancels
        // abort the signal and keep their own classification.
        // INTENT: the raw TypeError("fetch failed") normalized to UNKNOWN, so a
        // stopped model server read as a non-retryable invocation bug.
        if (timeout.signal.aborted || error instanceof LlmError) throw error;
        throw new LlmError("OpenAI-compatible provider is unreachable", "TRANSPORT", { cause: error });
      });
      if (!response.ok) {
        // Cleanup must not hold the HTTP failure behind a provider stream's
        // cancellation promise; aborting the request cannot settle that promise.
        const code = response.status === 400 || response.status === 413 || response.status === 422
          ? await providerFailureCode(response, timeout.signal) : "PROVIDER_HTTP_ERROR";
        if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
        throw new LlmError(
          `OpenAI-compatible provider returned HTTP ${response.status}`,
          code,
          { status: response.status },
        );
      }
      if (!response.body) throw new LlmError("provider response body is missing", "EMPTY_RESPONSE");

      const blocks = new Map<string, BlockState>();
      let nextIndex = 0;
      let buffer = "";
      let nativeFinish: string | undefined;
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
        if (payload.error !== undefined) {
          throw new LlmError("provider rejected the streamed request",
            isContextWindowExceededError(JSON.stringify(payload.error).slice(0, 8192))
              ? CONTEXT_WINDOW_EXCEEDED_CODE : "PROVIDER_STREAM_ERROR");
        }
        const chunks: StreamChunk[] = [];
        responseId ??= payload.id;
        actualProvider ??= payload.provider;
        // Null/absent is a normal stream placeholder. A supplied invalid
        // receipt invalidates the previous snapshot instead of reviving it.
        if (payload.usage != null) usage = usageOf(payload);
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
          if (call.function?.name) state.name = (state.name ?? "") + call.function.name;
          const argumentsDelta = call.function?.arguments ?? "";
          appendOutput(state, argumentsDelta);
          if (!state.id) throw new LlmError("provider tool call omitted its id", "INVALID_RESPONSE");
          chunks.push({
            type: "tool-call-delta",
            index: state.index,
            id: state.id as never,
            // DSH treats name as the current complete value, not a delta.
            ...(call.function?.name ? { name: state.name } : {}),
            argumentsDelta,
          });
        }
        return chunks;
      };

      providerStream: for await (const text of decodedResponseChunks(response.body, timeout.signal)) {
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
          if (!data) continue;
          // The provider terminates the message with DONE. Awaiting HTTP EOF
          // after it can turn a complete answer into an idle timeout; usage
          // trailers before DONE have already been accounted for above.
          if (data === "[DONE]") break providerStream;
          let payload: OpenAiStreamPayload;
          try {
            payload = JSON.parse(data) as OpenAiStreamPayload;
          } catch {
            // A local server under load has answered a 200 stream with a plain
            // error line; as a SyntaxError it was logged as an unclassified
            // failure with no provider code.
            throw new LlmError("provider sent a non-JSON stream event", "INVALID_RESPONSE");
          }
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
      // Attribution belongs to the actual provider response. Validate it before
      // accepting native text or tool calls.
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
      if (usage) yield { type: "usage", usage };

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
      if (requestStarted) this.observeUsage?.(usage);
    }
  }
}
