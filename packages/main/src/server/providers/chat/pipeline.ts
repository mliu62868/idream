import type { ChatChunk, ChatModel } from "../types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          characterName: input.characterName,
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Pipeline chat request failed with HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = (await response.json().catch(() => ({}))) as unknown;
        const content = contentFromJson(json);
        if (content) yield { delta: content, done: false };
        yield { delta: "", done: true };
        return;
      }

      if (!response.body) throw new Error("Pipeline chat response body is missing");
      yield* streamSseChat(response.body);
    } finally {
      clearTimeout(timeout);
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
      const content = deltaFromSsePayload(payload);
      if (content) yield { delta: content, done: false };
    }
  }
  yield { delta: "", done: true };
}

function deltaFromSsePayload(payload: string) {
  try {
    const json = JSON.parse(payload) as unknown;
    const record = asRecord(json);
    const choices = record.choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    if (!isRecord(first)) return "";
    const delta = first.delta;
    if (!isRecord(delta)) return "";
    return typeof delta.content === "string" ? delta.content : "";
  } catch {
    return "";
  }
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

function pipelineEndpoint(baseUrl: string, suffix: string) {
  const url = new URL(baseUrl);
  if (url.pathname.endsWith(suffix)) return url;
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${suffix}`;
  return url;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
