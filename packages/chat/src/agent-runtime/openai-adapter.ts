import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream, createProvider, getCurrentSystemPrompt, getCurrentTools,
  parseStreamingJson, parseToolCallArguments,
  type AssistantMessage, type Message, type Model, type Provider, type ProviderStreams,
  type AssistantMessageEventStream, type ToolCall,
} from "@earendil-works/pi-ai";

import { isOpenRouterBaseUrl } from "@idream/shared";
import type { CompanionModelRequestEvidence, CompanionModelTokenUsage, PreparedTurnProfile } from "./contracts";
import { estimateModelRequestInputTokens } from "./model-request-format";

export type TokenUsage = CompanionModelTokenUsage;
export interface OpenAiCompatibleAdapterOptions {
  profile: PreparedTurnProfile;
  apiKey: string;
  openRouterProviderOnly?: readonly string[];
  maxInputTokens?: number;
  samplingTemperature?: number;
  responseFormat?: { type: "json_schema"; json_schema: { name: string; strict: true; schema: Record<string, unknown> } };
  observeRequest?: (evidence: CompanionModelRequestEvidence) => void | Promise<void>;
  observeUsage?: (usage: TokenUsage | undefined, request: CompanionModelRequestEvidence) => void;
  fetch?: typeof globalThis.fetch;
}
export interface InvocationOptions {
  signal?: AbortSignal;
  purpose?: "compaction" | "warmup";
  maxTokens?: number;
  stop?: readonly string[];
}
export class ProviderError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, code: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.status = options?.status;
  }
}
const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
// Preserve the existing narrow overflow classifier; generic quota/size errors
// must not trigger context compaction.
function isContextWindowExceededError(detail: string): boolean {
  return /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i.test(detail);
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

function usageOf(payload: OpenAiStreamPayload): TokenUsage | undefined {
  if (!payload.usage) return undefined;
  const promptTokens = payload.usage.prompt_tokens ?? payload.usage.input_tokens;
  const completionTokens = payload.usage.completion_tokens ?? payload.usage.output_tokens;
  // Missing counters are unknown: treating them as zero would reuse a spent budget.
  if (typeof promptTokens !== "number" || !Number.isSafeInteger(promptTokens) || promptTokens < 0
    || typeof completionTokens !== "number" || !Number.isSafeInteger(completionTokens) || completionTokens < 0) return undefined;
  const cachedTokens = payload.usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = payload.usage.completion_tokens_details?.reasoning_tokens;
  // Detail counters are subsets of the measured totals. Invalid details must
  // not introduce NaN into downstream budget comparisons or invent a subtotal.
  if (!Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > promptTokens
    || (reasoningTokens !== undefined && (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > completionTokens))) return undefined;
  return {
    inputTokens: promptTokens - cachedTokens,
    outputTokens: completionTokens,
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
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
        new ProviderError("model stream idle timeout", "MODEL_IDLE_TIMEOUT"),
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
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, signal);
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
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

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

function wireMessages(messages: readonly Message[]): unknown[] {
  const system = getCurrentSystemPrompt(messages);
  return [
    ...(system ? [{ role: "system", content: system }] : []),
    ...messages.filter(message => message.role !== "system").map(message => {
      if (message.role === "toolResult") return {
        role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content),
      };
      if (message.role === "assistant") {
        const tools = message.content.filter((block): block is ToolCall => block.type === "toolCall");
        return { role: "assistant", content: textOf(message.content) || null,
          ...(tools.length ? { tool_calls: tools.map(tool => ({
            id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          })) } : {}),
        };
      }
      return { role: "user", content: textOf(message.content) || null };
    }),
  ];
}

interface BlockState {
  index: number;
  text: string;
  block: AssistantMessage["content"][number];
}

export class OpenAiCompatibleAdapter {
  private readonly config: OpenAiCompatibleAdapterOptions;
  private readonly apiKey: string;
  private readonly providerOnly?: readonly string[];
  private readonly openRouter: boolean;
  private readonly request: typeof globalThis.fetch;
  private readonly errors = new WeakMap<AssistantMessage, ProviderError>();
  private readonly receipts = new WeakMap<AssistantMessage, TokenUsage>();
  private readonly attributions = new WeakMap<AssistantMessage, { requestId?: string; actualProvider?: string }>();

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.config = options;
    this.apiKey = options.apiKey.trim();
    this.providerOnly = options.openRouterProviderOnly?.map(value => value.trim()).filter(Boolean);
    this.openRouter = isOpenRouterBaseUrl(options.profile.baseUrl);
    this.request = options.fetch ?? globalThis.fetch;
    if (!this.apiKey) throw new Error("OpenAI-compatible API key is required");
    if (this.openRouter && !this.providerOnly?.length) throw new Error("OpenRouter requires an exact provider pin");
  }

  getError(message: AssistantMessage): ProviderError | undefined { return this.errors.get(message); }
  getUsage(message: AssistantMessage): TokenUsage | undefined { return this.receipts.get(message); }
  getAttribution(message: AssistantMessage): { requestId?: string; actualProvider?: string } | undefined { return this.attributions.get(message); }

  resolveModel(provider: string, model: string) {
    const profile = this.config.profile;
    if (provider !== profile.provider || model !== profile.model) throw new ProviderError("model route differs from the pinned invocation profile", "INVALID_ROUTE");
    return Promise.resolve({ provider, id: model, name: model,
      ...(this.config.maxInputTokens === undefined ? {} : { contextWindow: this.config.maxInputTokens + profile.maxOutputTokens }),
      maxTokens: profile.maxOutputTokens,
    });
  }

  asProvider(options: { purpose?: "compaction" } = {}): Provider {
    const profile = this.config.profile;
    if (this.config.maxInputTokens === undefined) throw new Error("asProvider requires the prepared maxInputTokens");
    const model: Model<"openai-completions"> = {
      id: profile.model, name: profile.model, api: "openai-completions", provider: profile.provider,
      baseUrl: profile.baseUrl, input: ["text"], reasoning: false,
      contextWindow: this.config.maxInputTokens + profile.maxOutputTokens,
      maxTokens: profile.maxOutputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const stream: ProviderStreams["stream"] = (requested, context, invocation) => {
      if (requested.provider !== profile.provider || requested.id !== profile.model) {
        return this.failedStream(new ProviderError("model route differs from the pinned invocation profile", "INVALID_ROUTE"));
      }
      return this.stream(context.messages, { ...invocation, purpose: options.purpose });
    };
    return createProvider({ id: profile.provider, name: profile.provider, baseUrl: profile.baseUrl, models: [model],
      auth: { apiKey: { name: "Prepared provider key", resolve: async () => ({ auth: { apiKey: this.apiKey } }) } },
      api: { stream, streamSimple: stream },
    });
  }

  private emptyMessage(): AssistantMessage {
    const profile = this.config.profile;
    return { role: "assistant", content: [], api: "openai-completions", provider: profile.provider, model: profile.model,
      stopReason: "pending", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }

  private failedStream(error: ProviderError): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const message = this.emptyMessage();
    message.stopReason = "error";
    message.errorMessage = error.message;
    this.errors.set(message, error);
    stream.push({ type: "error", reason: "error", error: message });
    stream.end();
    return stream;
  }

  stream(messages: readonly Message[], options: InvocationOptions = {}): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const message = this.emptyMessage();
    void this.perform(messages, options, stream, message).then(() => {
      stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
    }, error => {
      const failure = error instanceof ProviderError ? error : new ProviderError(
        error instanceof Error ? error.message : "provider request failed", "PROVIDER_STREAM_ERROR");
      this.errors.set(message, failure);
      message.stopReason = options.signal?.aborted ? "aborted" : "error";
      // Pi's public overflow classifier sees only errorMessage, not host sidecars.
      message.errorMessage = failure.code === CONTEXT_WINDOW_EXCEEDED_CODE ? "context_length_exceeded" : failure.message;
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }).finally(() => stream.end());
    return stream;
  }

  private async perform(messages: readonly Message[], options: InvocationOptions,
    stream: AssistantMessageEventStream, output: AssistantMessage): Promise<void> {
    const { profile, maxInputTokens, responseFormat, observeRequest, observeUsage } = this.config;
    const compacting = options.purpose === "compaction";
    const thinking = !options.purpose && !responseFormat;
    const tools = getCurrentTools(messages);
    // The provider's output cap covers reasoning and visible text together.
    // Answer preferences cannot cap that shared budget for thinking requests.
    const maxTokens = compacting ? options.maxTokens ?? profile.maxOutputTokens : Math.min(
      options.maxTokens ?? profile.maxOutputTokens, profile.maxOutputTokens,
      thinking ? profile.maxOutputTokens : profile.answerMaxOutputTokens ?? profile.maxOutputTokens);
    const body = {
      model: profile.model, messages: wireMessages(messages), stream: true,
      stream_options: { include_usage: true },
      temperature: compacting ? 0 : this.config.samplingTemperature ?? profile.sampling.temperature,
      top_p: profile.sampling.topP, repetition_penalty: profile.sampling.repetitionPenalty,
      max_tokens: maxTokens,
      // Companion replies use the selected model's private reasoning. It shares
      // the request's total output budget; never force-close it into visible text.
      // Bounded summaries and structured extraction keep their non-thinking mode.
      chat_template_kwargs: { enable_thinking: thinking },
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      ...(tools.length ? { tools: tools.map(tool => ({ type: "function", function: {
        name: tool.name, description: tool.description, parameters: tool.parameters,
      } })), tool_choice: compacting ? "none" : "auto" } : {}),
      ...(this.openRouter ? { provider: { only: [...this.providerOnly!], allow_fallbacks: false } } : {}),
    };
    const timeout = linkedSignal(options.signal);
    let firstToken = true;
    const firstTokenTimer = setTimeout(() => timeout.abort(new ProviderError("model first-token timeout", "MODEL_FIRST_TOKEN_TIMEOUT")), profile.timeout.firstTokenMs);
    let requestStarted = false;
    let requestEvidence: CompanionModelRequestEvidence | undefined;
    let usage: TokenUsage | undefined;
    try {
      const estimatedInputTokens = estimateModelRequestInputTokens(body)
        + (responseFormat ? Math.ceil(JSON.stringify(responseFormat).length / 4) : 0);
      if (!compacting && maxInputTokens !== undefined && estimatedInputTokens > maxInputTokens) {
        throw new ProviderError("assembled model request exceeds the prepared input budget",
          responseFormat ? "INPUT_BUDGET_EXCEEDED" : CONTEXT_WINDOW_EXCEEDED_CODE);
      }
      const serializedBody = JSON.stringify(body);
      requestEvidence = { bodyDigest: createHash("sha256").update(serializedBody).digest("hex"),
        systemPromptDigest: createHash("sha256").update(getCurrentSystemPrompt(messages)).digest("hex"),
        estimatedInputTokens, ...(compacting ? { purpose: "compaction" } : maxInputTokens === undefined ? {} : { maxInputTokens }),
      };
      // Persist dispatch intent before crossing the external request boundary.
      // A process crash after this point must never silently resend it.
      await observeRequest?.(requestEvidence);
      timeout.signal.throwIfAborted();
      requestStarted = true;
      const response = await this.request(chatCompletionsUrl(profile.baseUrl), {
        method: "POST", headers: { "user-agent": "idream-chat/pi-provider", authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json", accept: "text/event-stream" },
        body: serializedBody, signal: timeout.signal,
      }).catch((error: unknown) => {
        if (timeout.signal.aborted) throw modelAbortReason(timeout.signal);
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("OpenAI-compatible provider is unreachable", "TRANSPORT", { cause: error });
      });
      if (!response.ok) {
        const code = [400, 413, 422].includes(response.status)
          ? await providerFailureCode(response, timeout.signal) : "PROVIDER_HTTP_ERROR";
        if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
        throw new ProviderError(`OpenAI-compatible provider returned HTTP ${response.status}`, code, { status: response.status });
      }
      if (!response.body) throw new ProviderError("provider response body is missing", "EMPTY_RESPONSE");
      stream.push({ type: "start", partial: output });
      const blocks = new Map<string, BlockState>();
      let buffer = "", nativeFinish: string | undefined, responseId: string | undefined, actualProvider: string | undefined;
      let responseBytes = 0, outputBytes = 0;
      const failStreamLimit = (message: string): never => {
        const error = new ProviderError(message, "PROVIDER_STREAM_LIMIT");
        timeout.abort(error);
        throw error;
      };
      const appendOutput = (state: BlockState, value: string): void => {
        outputBytes += Buffer.byteLength(value);
        if (outputBytes > MAX_PROVIDER_OUTPUT_BYTES) failStreamLimit("provider output exceeded the configured byte limit");
        state.text += value;
      };
      const ensure = (key: string, type: "text" | "thinking" | "toolCall", id?: string): BlockState => {
        const existing = blocks.get(key);
        if (existing) return existing;
        const block: AssistantMessage["content"][number] = type === "text" ? { type, text: "" }
          : type === "thinking" ? { type, thinking: "" } : { type, id: id ?? "", name: "", arguments: {} };
        const state = { index: output.content.length, text: "", block };
        output.content.push(block);
        blocks.set(key, state);
        stream.push({ type: type === "text" ? "text_start" : type === "thinking" ? "thinking_start" : "toolcall_start",
          contentIndex: state.index, partial: output });
        return state;
      };
      const processPayload = (payload: OpenAiStreamPayload): boolean => {
        if (payload.usage != null) usage = usageOf(payload);
        if (payload.error !== undefined) throw new ProviderError("provider rejected the streamed request",
          isContextWindowExceededError(JSON.stringify(payload.error).slice(0, 8192)) ? CONTEXT_WINDOW_EXCEEDED_CODE : "PROVIDER_STREAM_ERROR");
        responseId ??= payload.id;
        actualProvider ??= payload.provider;
        const choice = payload.choices?.[0];
        nativeFinish = choice?.finish_reason ?? nativeFinish;
        const delta = choice?.delta;
        let progressed = false;
        if (delta?.content) {
          const state = ensure("text", "text");
          appendOutput(state, delta.content);
          if (state.block.type === "text") state.block.text = state.text;
          stream.push({ type: "text_delta", contentIndex: state.index, delta: delta.content, partial: output });
          progressed = true;
        }
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) {
          const state = ensure("reasoning", "thinking");
          appendOutput(state, reasoning);
          if (state.block.type === "thinking") state.block.thinking = state.text;
          stream.push({ type: "thinking_delta", contentIndex: state.index, delta: reasoning, partial: output });
          progressed = true;
        }
        for (const call of delta?.tool_calls ?? []) {
          const state = ensure(`tool:${call.index ?? 0}`, "toolCall", call.id);
          const block = state.block as ToolCall;
          block.id ||= call.id ?? "";
          if (call.function?.name) block.name += call.function.name;
          const argumentsDelta = call.function?.arguments ?? "";
          appendOutput(state, argumentsDelta);
          if (!block.id) throw new ProviderError("provider tool call omitted its id", "INVALID_RESPONSE");
          block.arguments = parseStreamingJson(state.text);
          stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: argumentsDelta, partial: output });
          progressed ||= Boolean(call.function?.name || argumentsDelta);
        }
        return progressed;
      };
      providerStream: for await (const text of decodedResponseChunks(response.body, timeout.signal)) {
        responseBytes += Buffer.byteLength(text);
        if (responseBytes > MAX_PROVIDER_STREAM_BYTES) failStreamLimit("provider stream exceeded the configured byte limit");
        buffer += text;
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary || boundary.index === undefined) break;
          const event = buffer.slice(0, boundary.index);
          if (Buffer.byteLength(event) > MAX_PROVIDER_EVENT_BYTES) failStreamLimit("provider SSE event exceeded the configured byte limit");
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          if (data === "[DONE]") break providerStream;
          let payload: OpenAiStreamPayload;
          try { payload = JSON.parse(data); }
          catch { throw new ProviderError("provider sent a non-JSON stream event", "INVALID_RESPONSE"); }
          if (processPayload(payload)) {
            if (firstToken) clearTimeout(firstTokenTimer);
            firstToken = false;
            timeout.resetIdle(profile.timeout.idleMs);
          }
        }
        if (Buffer.byteLength(buffer) > MAX_PROVIDER_EVENT_BYTES) failStreamLimit("provider SSE event exceeded the configured byte limit");
      }
      if (!nativeFinish) throw new ProviderError("provider stream ended without a finish reason", "INVALID_RESPONSE");
      const finish = nativeFinish === "stop" ? "stop" : nativeFinish === "length" ? "length"
        : nativeFinish === "tool_calls" || nativeFinish === "function_call" ? "toolUse" : undefined;
      if (!finish) throw new ProviderError(`provider returned unsupported finish_reason ${nativeFinish}`, "INVALID_RESPONSE");
      if (this.openRouter) {
        if (!responseId || !actualProvider) throw new ProviderError("OpenRouter stream omitted request/provider attribution", "INVALID_RESPONSE");
        const attributed = actualProvider.trim().toLocaleLowerCase();
        if (!this.providerOnly?.some(provider => provider.toLocaleLowerCase() === attributed)) {
          throw new ProviderError(`OpenRouter attributed the response to unpinned provider ${actualProvider}`, "INVALID_RESPONSE");
        }
      }
      output.responseId = responseId;
      if (responseId || actualProvider) this.attributions.set(output, {
        ...(responseId ? { requestId: responseId } : {}), ...(actualProvider ? { actualProvider } : {}),
      });
      output.rawStopReason = nativeFinish;
      for (const state of blocks.values()) {
        const block = state.block;
        if (block.type === "text") stream.push({ type: "text_end", contentIndex: state.index, content: block.text, partial: output });
        else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: state.index, content: block.thinking, partial: output });
        else {
          Object.assign(block, parseToolCallArguments(state.text));
          stream.push({ type: "toolcall_end", contentIndex: state.index, toolCall: block, partial: output });
        }
      }
      output.stopReason = finish;
    } finally {
      clearTimeout(firstTokenTimer);
      timeout.clear();
      if (usage) {
        this.receipts.set(output, usage);
        output.usage = { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0,
          reasoning: usage.reasoningTokens, totalTokens: usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      }
      if (requestStarted && requestEvidence) observeUsage?.(usage, requestEvidence);
    }
  }
}
