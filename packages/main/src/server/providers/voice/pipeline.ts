import { randomUUID } from "node:crypto";
import type { BlobStore, ProviderResult, VoiceModel } from "../types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PipelineVoiceModelConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Speaker used when a character has no voiceId. Model-specific (e.g. "serena"
   *  for Qwen3-TTS); the generic "default" 500s on speaker-keyed TTS servers. */
  defaultVoiceId?: string;
  timeoutMs?: number;
  blob: BlobStore;
  fetchImpl?: FetchLike;
}

export class PipelineVoiceModel implements VoiceModel {
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly defaultVoiceId: string;
  private readonly timeoutMs: number;
  private readonly blob: BlobStore;
  private readonly fetchImpl: FetchLike;

  constructor(config: PipelineVoiceModelConfig) {
    this.endpoint = pipelineEndpoint(config.baseUrl, "/audio/speech");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.defaultVoiceId = config.defaultVoiceId?.trim() || "default";
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 60_000);
    this.blob = config.blob;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async synthesize(input: Parameters<VoiceModel["synthesize"]>[0]) {
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
          input: input.text,
          voice: input.voiceId ?? this.defaultVoiceId,
          response_format: "mp3",
          // OpenAI-compatible delivery control (gpt-4o-mini-tts / MOSS-TTS); omit when absent.
          ...(input.tone ? { instructions: input.tone } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return voiceFailure(response.status);

      const contentType = response.headers.get("content-type") ?? "audio/mpeg";
      if (contentType.includes("application/json")) {
        const json = (await response.json().catch(() => ({}))) as unknown;
        const parsed = parseJsonVoiceResult(json);
        if (parsed) return { ok: true as const, data: parsed };
        return {
          ok: false as const,
          error: {
            code: "invalid_voice_response",
            message: "Pipeline voice response missing key",
            retryable: true,
          },
        };
      }

      const key = `voice/${randomUUID()}${audioFileExtension(contentType)}`;
      const body = new Uint8Array(await response.arrayBuffer());
      const stored = await this.blob.putPrivate({ key, body, contentType });
      if (!stored.ok) return stored;
      return {
        ok: true as const,
        data: {
          key,
          durationMs: estimateDurationMs(input.text),
        },
      };
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code:
            error instanceof Error && error.name === "AbortError"
              ? "voice_timeout"
              : "voice_request_failed",
          message: error instanceof Error ? error.message : "Pipeline voice request failed",
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonVoiceResult(value: unknown) {
  const record = asRecord(value);
  const nested = asRecord(record.audio);
  const key = stringField(record, "key") ?? stringField(nested, "key");
  if (!key) return undefined;
  return {
    key,
    durationMs:
      numberField(record, "durationMs") ??
      numberField(record, "duration_ms") ??
      numberField(nested, "durationMs") ??
      numberField(nested, "duration_ms") ??
      0,
  };
}

function voiceFailure(status: number): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code: status === 429 ? "voice_rate_limited" : "voice_request_failed",
      message: `Pipeline voice request failed with HTTP ${status}`,
      retryable: status === 408 || status === 429 || status >= 500,
    },
  };
}

function estimateDurationMs(text: string) {
  return Math.max(500, text.length * 35);
}

function audioFileExtension(contentType: string) {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/webm": ".webm",
  };
  return mediaType ? (extensions[mediaType] ?? ".bin") : ".bin";
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

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
