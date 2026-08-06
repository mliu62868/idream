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

export interface PocketTtsVoiceModelConfig {
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

type PocketVoiceResponse = {
  voice_id?: unknown;
  model?: unknown;
  language?: unknown;
};

type PocketHealthResponse = {
  voice_cloning?: unknown;
  runtime?: unknown;
  runtime_version?: unknown;
  acceleration?: unknown;
};

export class PocketTtsVoiceModel implements VoiceClipPort, VoiceIdentityPort {
  readonly providerKey = "pocket_tts" as const;
  readonly providerReplay = VOICE_PROVIDER_REPLAY.pocket_tts;

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

  constructor(config: PocketTtsVoiceModelConfig) {
    this.speechEndpoint = pocketEndpoint(config.baseUrl, "/audio/speech");
    this.voicesEndpoint = pocketEndpoint(config.baseUrl, "/voices");
    this.healthEndpoint = pocketEndpoint(config.baseUrl, "/health");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.language = config.language;
    this.defaultVoiceId = config.defaultVoiceId?.trim() || "alba";
    this.maxInputChars = Math.max(1, config.maxInputChars ?? 900);
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 120_000);
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
        sceneAdapter: "pocket-tts-scene-1",
      },
    };
  }

  async previewVoice(input: Parameters<VoiceIdentityPort["previewVoice"]>[0]) {
    return this.renderVoice(input);
  }

  private async renderVoice(input: {
    text: string;
    voiceId?: string;
    requestId?: string;
    attemptNo?: number;
    idempotencyKey?: string;
    scene?: Parameters<VoiceClipPort["synthesize"]>[0]["scene"];
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
        ...(input.scene ? {
          scene: input.scene,
          scene_instructions: voiceSceneInstructions(input.scene),
        } : {}),
      }),
    });
    if (!response.ok) return response;

    const contentType = response.data.headers.get("content-type") ?? "audio/wav";
    if (!contentType.includes("audio/")) {
      return pocketFailure(
        "invalid_voice_response",
        "Pocket TTS returned a non-audio response",
        true,
      );
    }
    const body = new Uint8Array(await response.data.arrayBuffer());
    if (body.byteLength === 0) {
      return pocketFailure("invalid_voice_response", "Pocket TTS returned empty audio", true);
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

  async cloneVoice(input: Parameters<VoiceIdentityPort["cloneVoice"]>[0]) {
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
    const raw = await response.data.json().catch(() => null) as PocketVoiceResponse | null;
    if (
      !raw ||
      typeof raw.voice_id !== "string" ||
      typeof raw.model !== "string" ||
      typeof raw.language !== "string"
    ) {
      return pocketFailure(
        "invalid_voice_clone_response",
        "Pocket TTS voice clone response is incomplete",
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

  async deleteVoice(input: Parameters<VoiceIdentityPort["deleteVoice"]>[0]) {
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
      {
        method: "GET",
        headers: this.authHeaders(),
      },
      Math.min(this.timeoutMs, 2_000),
    );
    if (!response.ok) return response;
    const raw = await response.data.json().catch(() => null) as PocketHealthResponse | null;
    if (
      !raw ||
      typeof raw.voice_cloning !== "boolean" ||
      raw.runtime !== "omlx" ||
      typeof raw.runtime_version !== "string" ||
      raw.runtime_version.trim().length === 0 ||
      raw.acceleration !== "mlx"
    ) {
      return pocketFailure(
        "invalid_voice_health_response",
        "Pocket TTS gateway is not running the required MLX backend",
        true,
      );
    }
    return {
      ok: true as const,
      data: {
        voiceCloning: raw.voice_cloning,
        runtime: raw.runtime,
        runtimeVersion: raw.runtime_version,
        acceleration: raw.acceleration,
      },
    };
  }

  private jsonHeaders() {
    return {
      ...this.authHeaders(),
      "content-type": "application/json",
    };
  }

  private authHeaders() {
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
      return pocketFailure(
        response.status === 404 ? "voice_not_found" : "pocket_tts_failed",
        details.trim() || `Pocket TTS returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    } catch (error) {
      return pocketFailure(
        error instanceof Error && error.name === "AbortError"
          ? "voice_timeout"
          : "voice_request_failed",
        error instanceof Error ? error.message : "Pocket TTS request failed",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function pocketEndpoint(baseUrl: string, suffix: string) {
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
  ) return null;
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
  return byteRate && dataSize !== null ? Math.round((dataSize / byteRate) * 1_000) : null;
}

function ascii(body: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...body.subarray(offset, offset + length));
}

function estimateDurationMs(text: string) {
  return Math.max(500, Math.round(text.trim().length * 55));
}

function pocketFailure(
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
