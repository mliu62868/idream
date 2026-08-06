import {
  VOICE_PROVIDER_REPLAY,
  voiceSceneInstructions,
  type BlobStore,
  type ProviderResult,
  type VoiceClipPort,
  type VoiceIdentityPort,
} from "../types";
import { voiceArtifactKey } from "./idempotency";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FishAudioVoiceModelConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  language: string;
  defaultVoiceId?: string;
  maxInputChars?: number;
  timeoutMs?: number;
  blob: BlobStore;
  fetchImpl?: FetchLike;
}

type FishVoiceResponse = {
  voice_id?: unknown;
  model?: unknown;
  language?: unknown;
};

type FishHealthResponse = {
  voice_cloning?: unknown;
  system_voice_ready?: unknown;
  runtime?: unknown;
  runtime_version?: unknown;
  acceleration?: unknown;
  model_loaded?: unknown;
};

export class FishAudioVoiceModel implements VoiceClipPort, VoiceIdentityPort {
  readonly providerKey = "fish_audio" as const;
  readonly providerReplay = VOICE_PROVIDER_REPLAY.fish_audio;

  private readonly speechEndpoint: URL;
  private readonly voicesEndpoint: URL;
  private readonly healthEndpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly language: string;
  private readonly defaultVoiceId: string;
  private readonly maxInputChars: number;
  private readonly timeoutMs: number;
  private readonly blob: BlobStore;
  private readonly fetchImpl: FetchLike;

  constructor(config: FishAudioVoiceModelConfig) {
    this.speechEndpoint = fishEndpoint(config.baseUrl, "/audio/speech");
    this.voicesEndpoint = fishEndpoint(config.baseUrl, "/voices");
    this.healthEndpoint = fishEndpoint(config.baseUrl, "/health");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.language = config.language;
    this.defaultVoiceId =
      config.defaultVoiceId?.trim() || "fish-female-default";
    this.maxInputChars = Math.max(1, config.maxInputChars ?? 900);
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 180_000);
    this.blob = config.blob;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async synthesize(input: Parameters<VoiceClipPort["synthesize"]>[0]) {
    const rendered = await this.renderVoice(input);
    if (!rendered.ok) return rendered;
    const key = voiceArtifactKey(input.idempotencyKey, ".wav");
    const stored = await this.blob.putPrivate({
      key,
      body: rendered.data.body,
      contentType: rendered.data.contentType,
    });
    if (!stored.ok) return stored;
    return {
      ok: true as const,
      data: {
        key,
        durationMs: rendered.data.durationMs,
        sceneApplied: true,
        sceneAdapter: "fish-audio-scene-1",
      },
    };
  }

  async previewVoice(
    input: Parameters<VoiceIdentityPort["previewVoice"]>[0],
  ) {
    return this.renderVoice(input);
  }

  async cloneVoice(
    input: Parameters<VoiceIdentityPort["cloneVoice"]>[0],
  ) {
    const form = new FormData();
    form.set("voice_id", input.voiceId);
    form.set("language", input.language || this.language);
    form.set("ref_text", input.referenceText);
    form.set(
      "audio",
      new Blob([arrayBuffer(input.audio)], { type: input.contentType }),
      input.filename,
    );
    const response = await this.request(this.voicesEndpoint, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!response.ok) return response;
    const raw = (await response.data.json().catch(() => null)) as
      | FishVoiceResponse
      | null;
    if (
      !raw ||
      typeof raw.voice_id !== "string" ||
      typeof raw.model !== "string" ||
      typeof raw.language !== "string"
    ) {
      return fishFailure(
        "invalid_voice_clone_response",
        "Fish Audio voice clone response is incomplete",
        false,
      );
    }
    return {
      ok: true as const,
      data: {
        voiceId: raw.voice_id,
        model: raw.model,
        language: raw.language,
      },
    };
  }

  async deleteVoice(
    input: Parameters<VoiceIdentityPort["deleteVoice"]>[0],
  ) {
    const endpoint = new URL(
      `${this.voicesEndpoint.toString().replace(/\/$/, "")}/${encodeURIComponent(input.voiceId)}`,
    );
    const response = await this.request(endpoint, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!response.ok) return response;
    return { ok: true as const, data: { deleted: true as const } };
  }

  async inspectCapabilities() {
    const response = await this.request(
      this.healthEndpoint,
      { method: "GET", headers: this.authHeaders() },
      Math.min(this.timeoutMs, 2_000),
    );
    if (!response.ok) return response;
    const raw = (await response.data.json().catch(() => null)) as
      | FishHealthResponse
      | null;
    if (
      !raw ||
      raw.voice_cloning !== true ||
      raw.system_voice_ready !== true ||
      raw.runtime !== "mlx_audio" ||
      typeof raw.runtime_version !== "string" ||
      raw.runtime_version.trim().length === 0 ||
      raw.acceleration !== "mlx" ||
      raw.model_loaded !== true
    ) {
      return fishFailure(
        "invalid_voice_health_response",
        "Fish Audio gateway is not running the resident MLX model",
        true,
      );
    }
    return {
      ok: true as const,
      data: {
        voiceCloning: true,
        runtime: raw.runtime,
        runtimeVersion: raw.runtime_version,
        acceleration: raw.acceleration,
      },
    };
  }

  private async renderVoice(input: {
    text: string;
    voiceId?: string;
    tone?: string;
    delivery?: Parameters<VoiceClipPort["synthesize"]>[0]["delivery"];
    scene?: Parameters<VoiceClipPort["synthesize"]>[0]["scene"];
    requestId?: string;
    attemptNo?: number;
    idempotencyKey?: string;
  }) {
    const response = await this.request(this.speechEndpoint, {
      method: "POST",
      headers: {
        ...this.jsonHeaders(),
        ...(input.idempotencyKey
          ? { "idempotency-key": input.idempotencyKey }
          : {}),
        ...(input.requestId
          ? { "x-idream-request-id": input.requestId }
          : {}),
        ...(input.attemptNo
          ? { "x-idream-attempt-no": String(input.attemptNo) }
          : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: limitText(input.text, this.maxInputChars),
        voice: input.voiceId?.trim() || this.defaultVoiceId,
        response_format: "wav",
        ...(input.delivery ? { delivery: input.delivery } : {}),
        ...(input.tone ? { tone: input.tone } : {}),
        ...(input.scene ? {
          scene: input.scene,
          scene_instructions: voiceSceneInstructions(input.scene),
        } : {}),
      }),
    });
    if (!response.ok) return response;

    const contentType = response.data.headers.get("content-type") ?? "audio/wav";
    if (!contentType.includes("audio/")) {
      return fishFailure(
        "invalid_voice_response",
        "Fish Audio returned a non-audio response",
        true,
      );
    }
    const body = new Uint8Array(await response.data.arrayBuffer());
    if (body.byteLength === 0) {
      return fishFailure(
        "invalid_voice_response",
        "Fish Audio returned empty audio",
        true,
      );
    }
    return {
      ok: true as const,
      data: {
        body,
        contentType: "audio/wav" as const,
        durationMs: wavDurationMs(body) ?? estimateDurationMs(input.text),
      },
    };
  }

  private jsonHeaders() {
    return { ...this.authHeaders(), "content-type": "application/json" };
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async request(
    endpoint: URL,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<ProviderResult<Response>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        ...init,
        signal: controller.signal,
      });
      if (response.ok) return { ok: true, data: response };
      const details = await response.text().catch(() => "");
      return fishFailure(
        response.status === 404 ? "voice_not_found" : "fish_audio_failed",
        details.trim() || `Fish Audio returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    } catch (error) {
      return fishFailure(
        error instanceof Error && error.name === "AbortError"
          ? "voice_timeout"
          : "voice_request_failed",
        error instanceof Error ? error.message : "Fish Audio request failed",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function fishEndpoint(baseUrl: string, suffix: string) {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix.replace(/^\//, ""), normalized);
}

function limitText(text: string, max: number) {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const clipped = clean.slice(0, max);
  const sentence = clipped.match(/^[\s\S]*[.!?](?:\s|$)/)?.[0]?.trim();
  return sentence || clipped.trimEnd();
}

function wavDurationMs(body: Uint8Array) {
  if (
    body.byteLength < 44 ||
    ascii(body, 0, 4) !== "RIFF" ||
    ascii(body, 8, 4) !== "WAVE"
  ) {
    return null;
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  while (offset + 8 <= body.byteLength) {
    const chunk = ascii(body, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (chunk === "fmt " && size >= 12 && offset + 20 <= body.byteLength) {
      byteRate = view.getUint32(offset + 16, true);
    }
    if (chunk === "data") {
      dataSize = Math.min(size, Math.max(0, body.byteLength - offset - 8));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return byteRate && dataSize !== null
    ? Math.round((dataSize / byteRate) * 1_000)
    : null;
}

function ascii(body: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...body.subarray(offset, offset + length));
}

function estimateDurationMs(text: string) {
  return Math.max(500, Math.round(text.trim().length * 55));
}

function fishFailure(
  code: string,
  message: string,
  retryable: boolean,
): ProviderResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

function arrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
