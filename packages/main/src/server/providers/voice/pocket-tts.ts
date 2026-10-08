import {
  type ProviderResult,
  type VoiceClipPort,
  type VoiceIdentityPort,
} from "../types";
import { pcmWavDurationMs } from "./wav";
import { requestVoiceProvider, voiceOwnerHeaders } from "./http";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PocketTtsVoiceModelConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  language: string;
  defaultVoiceId?: string;
  maxInputChars?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

type PocketVoiceResponse = {
  voice_id?: unknown;
  preset_voice_id?: unknown;
  model?: unknown;
  language?: unknown;
};

type PocketHealthResponse = {
  voice_cloning?: unknown;
  catalog_ready?: unknown;
  catalog_voices?: unknown;
  runtime?: unknown;
  runtime_version?: unknown;
  acceleration?: unknown;
  model_loaded?: unknown;
  model_revision?: unknown;
  config_fingerprint?: unknown;
  system_voice_ready?: unknown;
};

export class PocketTtsVoiceModel implements VoiceClipPort, VoiceIdentityPort {
  readonly providerKey = "pocket_tts" as const;

  private readonly speechEndpoint: URL;
  private readonly voicesEndpoint: URL;
  private readonly presetVoicesEndpoint: URL;
  private readonly healthEndpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly language: string;
  private readonly defaultVoiceId: string;
  private readonly maxInputChars: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: PocketTtsVoiceModelConfig) {
    this.speechEndpoint = pocketEndpoint(config.baseUrl, "/audio/speech");
    this.voicesEndpoint = pocketEndpoint(config.baseUrl, "/voices");
    this.presetVoicesEndpoint = pocketEndpoint(config.baseUrl, "/voices/presets");
    this.healthEndpoint = pocketEndpoint(config.baseUrl, "/health");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.language = config.language;
    this.defaultVoiceId = config.defaultVoiceId?.trim() || "anna";
    this.maxInputChars = Math.min(2_000, Math.max(1, config.maxInputChars ?? 2_000));
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 120_000);
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
        // Pocket 3.0.2 does not expose Fish-style scene/delivery controls.
        sceneApplied: false,
        sceneAdapter: "pocket-tts-reference-state-1",
      },
    };
  }

  async previewVoice(input: Parameters<VoiceIdentityPort["previewVoice"]>[0]) {
    return this.renderVoice(input);
  }

  private async renderVoice(input: {
    ownerId?: string;
    text: string;
    voiceId?: string;
    requestId?: string;
    attemptNo?: number;
    idempotencyKey?: string;
    scene?: Parameters<VoiceClipPort["synthesize"]>[0]["scene"];
  }) {
    const text = input.text.trim();
    if (!text) return pocketFailure("voice_input_empty", "Voice input is empty", false);
    if (text.length > this.maxInputChars) return pocketFailure("voice_input_too_long", `Voice input exceeds ${this.maxInputChars} characters; no text was truncated`, false);
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
      }),
    });
    if (!response.ok) return response;

    const contentType = response.data.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "audio/wav" && contentType !== "audio/x-wav") {
      return pocketFailure(
        "invalid_voice_response",
        "Pocket TTS returned a non-WAV response",
        true,
      );
    }
    const body = new Uint8Array(await response.data.arrayBuffer());
    const durationMs = pcmWavDurationMs(body);
    if (durationMs === null) return pocketFailure("invalid_voice_response", "Pocket TTS returned invalid PCM WAV audio", true);
    return {
      ok: true as const,
      data: {
        body,
        contentType: "audio/wav" as const,
        durationMs,
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
      headers: { ...this.authHeaders(), ...voiceOwnerHeaders(input.ownerId) },
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

  async createPresetVoice(input: {
    ownerId?: string;
    voiceId: string;
    presetVoiceId: string;
    language: string;
  }) {
    const response = await this.request(this.presetVoicesEndpoint, {
      method: "POST",
      headers: { ...this.jsonHeaders(), ...voiceOwnerHeaders(input.ownerId) },
      body: JSON.stringify({
        voice_id: input.voiceId,
        preset_voice_id: input.presetVoiceId,
        language: input.language || this.language,
      }),
    });
    if (!response.ok) return response;
    const raw = await response.data.json().catch(() => null) as PocketVoiceResponse | null;
    if (
      !raw ||
      typeof raw.voice_id !== "string" ||
      typeof raw.preset_voice_id !== "string" ||
      typeof raw.model !== "string" ||
      typeof raw.language !== "string"
    ) {
      return pocketFailure(
        "invalid_voice_preset_response",
        "Pocket TTS preset voice response is incomplete",
        false,
      );
    }
    return {
      ok: true as const,
      data: {
        voiceId: raw.voice_id,
        presetVoiceId: raw.preset_voice_id,
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

  async eraseAccount(input: Parameters<NonNullable<VoiceClipPort["eraseAccount"]>>[0]) {
    const response = await this.request(new URL("account-erasure", this.voicesEndpoint), {
      method: "POST", headers: this.jsonHeaders(),
      body: JSON.stringify({ subject_hash: input.subjectHash, request_keys: input.requestKeys, voice_ids: input.voiceIds }),
    });
    if (!response.ok) return response;
    const receipt = await response.data.json().catch(() => null);
    if (receipt?.erased !== true) return pocketFailure("invalid_voice_erasure_receipt", "Pocket TTS did not confirm account erasure", true);
    return { ok: true as const, data: { erased: true as const } };
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
      raw.catalog_ready !== true ||
      !Array.isArray(raw.catalog_voices) ||
      raw.catalog_voices.length === 0 ||
      !raw.catalog_voices.every(
        (voiceId) => typeof voiceId === "string" && voiceId.trim().length > 0,
      ) ||
      raw.runtime !== "pocket_tts" ||
      typeof raw.runtime_version !== "string" ||
      raw.runtime_version.trim().length === 0 ||
      raw.acceleration !== "cpu" ||
      raw.model_loaded !== true ||
      raw.system_voice_ready !== true ||
      typeof raw.model_revision !== "string" ||
      raw.model_revision.trim().length === 0 ||
      typeof raw.config_fingerprint !== "string" ||
      raw.config_fingerprint.trim().length === 0
    ) {
      return pocketFailure(
        "invalid_voice_health_response",
        "Pocket TTS gateway is not running the required official CPU runtime",
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
        catalogVoices: raw.catalog_voices as string[],
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
    return requestVoiceProvider({ endpoint, init, timeoutMs, fetchImpl: this.fetchImpl,
      providerName: "Pocket TTS", failureCode: "pocket_tts_failed" });
  }
}

function pocketEndpoint(baseUrl: string, suffix: string) {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix.replace(/^\//, ""), normalized);
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
