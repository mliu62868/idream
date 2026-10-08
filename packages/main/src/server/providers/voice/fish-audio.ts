import {
  type ProviderResult,
  type VoiceClipPort,
  type VoiceIdentityPort,
} from "../types";
import { pcmWavDurationMs } from "./wav";
import { requestVoiceProvider, voiceOwnerHeaders } from "./http";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FishAudioVoiceModelConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  language: string;
  defaultVoiceId?: string;
  maxInputChars?: number;
  timeoutMs?: number;
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

  private readonly speechEndpoint: URL;
  private readonly voicesEndpoint: URL;
  private readonly healthEndpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly language: string;
  private readonly defaultVoiceId: string;
  private readonly maxInputChars: number;
  private readonly timeoutMs: number;
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
    this.maxInputChars = Math.min(2_000, Math.max(1, config.maxInputChars ?? 2_000));
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 180_000);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async synthesize(input: Parameters<VoiceClipPort["synthesize"]>[0]) {
    const rendered = await this.renderVoice(input);
    if (!rendered.ok) return rendered;
    return {
      ok: true as const,
      data: {
        body: rendered.data.body,
        contentType: rendered.data.contentType,
        durationMs: rendered.data.durationMs,
        // The resident gateway applies delivery, but has no Scene/tone input.
        sceneApplied: false,
        sceneAdapter: "fish-audio-delivery-1",
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
      headers: { ...this.authHeaders(), ...voiceOwnerHeaders(input.ownerId) },
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

  async eraseAccount(input: Parameters<NonNullable<VoiceClipPort["eraseAccount"]>>[0]) {
    const response = await this.request(new URL("account-erasure", this.voicesEndpoint), {
      method: "POST", headers: this.jsonHeaders(),
      body: JSON.stringify({ subject_hash: input.subjectHash, request_keys: input.requestKeys, voice_ids: input.voiceIds }),
    });
    if (!response.ok) return response;
    const receipt = await response.data.json().catch(() => null);
    if (receipt?.erased !== true) return fishFailure("invalid_voice_erasure_receipt", "Fish Audio did not confirm account erasure", true);
    return { ok: true as const, data: { erased: true as const } };
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
    ownerId?: string;
    text: string;
    voiceId?: string;
    tone?: string;
    delivery?: Parameters<VoiceClipPort["synthesize"]>[0]["delivery"];
    scene?: Parameters<VoiceClipPort["synthesize"]>[0]["scene"];
    requestId?: string;
    attemptNo?: number;
    idempotencyKey?: string;
  }) {
    const text = input.text.trim();
    if (!text) return fishFailure("voice_input_empty", "Voice input is empty", false);
    if (text.length > this.maxInputChars) return fishFailure("voice_input_too_long", `Voice input exceeds ${this.maxInputChars} characters; no text was truncated`, false);
    const response = await this.request(this.speechEndpoint, {
      method: "POST",
      headers: {
        ...this.jsonHeaders(),
        ...voiceOwnerHeaders(input.ownerId),
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
        input: text,
        voice: input.voiceId?.trim() || this.defaultVoiceId,
        response_format: "wav",
        ...(input.delivery ? { delivery: input.delivery } : {}),
      }),
    });
    if (!response.ok) return response;

    const contentType = response.data.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "audio/wav" && contentType !== "audio/x-wav") {
      return fishFailure(
        "invalid_voice_response",
        "Fish Audio returned a non-WAV response",
        true,
      );
    }
    const body = new Uint8Array(await response.data.arrayBuffer());
    const durationMs = pcmWavDurationMs(body);
    if (durationMs === null) return fishFailure("invalid_voice_response", "Fish Audio returned invalid PCM WAV audio", true);
    return {
      ok: true as const,
      data: {
        body,
        contentType: "audio/wav" as const,
        durationMs,
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
    return requestVoiceProvider({ endpoint, init, timeoutMs, fetchImpl: this.fetchImpl,
      providerName: "Fish Audio", failureCode: "fish_audio_failed" });
  }
}

function fishEndpoint(baseUrl: string, suffix: string) {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix.replace(/^\//, ""), normalized);
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
