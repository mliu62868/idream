import { pipelineEndpoint } from "@idream/shared/env";
import type { ChatChunk, ChatModel } from "../types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class PipelineChatRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "http" | "network" | "response",
    readonly requestId: string,
    readonly status?: number,
    readonly timeoutPhase?: "first_token" | "idle" | "deadline",
  ) { super(message); this.name = "PipelineChatRequestError"; }
}

export interface PipelineChatModelConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export class PipelineChatModel implements ChatModel {
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: PipelineChatModelConfig) {
    this.endpoint = pipelineEndpoint(config.baseUrl, "/chat/completions");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 60_000);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    const controller = new AbortController();
    const requestId = input.requestId ?? crypto.randomUUID();
    const progressBudget = input.timeoutMode === "progress";
    let timeoutPhase: PipelineChatRequestError["timeoutPhase"];
    let waitPhase: "first_token" | "idle" = "first_token";
    const abort = (phase: NonNullable<typeof timeoutPhase>) => {
      timeoutPhase = phase;
      controller.abort();
    };
    let timeout = setTimeout(() => abort(progressBudget ? waitPhase : "deadline"), this.timeoutMs);
    // Admin's five bounded drafts may progress slowly on the shared local GPU.
    // Continuous output can renew idle waiting, but cannot run forever.
    const deadline = progressBudget ? setTimeout(() => abort("deadline"), 180_000) : undefined;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          characterName: input.characterName,
          stream: true,
          ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
          // Match the chat service adapter: self-hosted Qwen reasoning models can
          // spend the whole probe budget in hidden thinking before emitting content.
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new PipelineChatRequestError(`Pipeline chat request failed with HTTP ${response.status}`, "http", requestId, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = await response.json() as unknown;
        const content = contentFromJson(json);
        if (content) yield { delta: content, done: false };
        const finishReason = finishReasonFromJson(json);
        yield { delta: "", done: true, ...(finishReason ? { finishReason } : {}) };
        return;
      }

      if (!response.body) throw new PipelineChatRequestError("Pipeline chat response body is missing", "response", requestId, response.status);
      for await (const chunk of streamSseChat(response.body)) {
        if (progressBudget && chunk.delta.length > 0) {
          waitPhase = "idle";
          clearTimeout(timeout);
          timeout = setTimeout(() => abort("idle"), this.timeoutMs);
        }
        yield chunk;
      }
    } catch (cause) {
      if (timeoutPhase) throw new PipelineChatRequestError("The chat model exceeded its request budget", "timeout", requestId, undefined, timeoutPhase);
      if (cause instanceof PipelineChatRequestError) throw cause;
      if (cause instanceof SyntaxError) throw new PipelineChatRequestError("The chat model returned invalid JSON", "response", requestId);
      throw new PipelineChatRequestError("The chat model connection failed", "network", requestId);
    } finally {
      clearTimeout(timeout);
      clearTimeout(deadline);
    }
  }
}

async function* streamSseChat(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") {
        yield { delta: "", done: true };
        return;
      }
      const chunk = chunkFromSsePayload(payload);
      if (chunk) yield chunk;
    }
  }
  yield { delta: "", done: true };
}

function chunkFromSsePayload(payload: string): ChatChunk | undefined {
  try {
    const json = JSON.parse(payload) as unknown;
    const record = asRecord(json);
    const choices = record.choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    if (!isRecord(first)) return undefined;
    const delta = first.delta;
    const content = isRecord(delta) && typeof delta.content === "string" ? delta.content : "";
    const finishReason = finishReasonFromJson(json);
    return content || finishReason ? { delta: content, done: false, ...(finishReason ? { finishReason } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

function finishReasonFromJson(value: unknown): string | undefined {
  const choices = asRecord(value).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  return isRecord(first) && typeof first.finish_reason === "string" ? first.finish_reason : undefined;
}

function contentFromJson(value: unknown) {
  const record = asRecord(value);
  const choices = record.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  if (isRecord(first)) {
    const message = first.message;
    if (isRecord(message) && typeof message.content === "string") return message.content;
    const text = first.text;
    if (typeof text === "string") return text;
  }
  return typeof record.content === "string" ? record.content : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
