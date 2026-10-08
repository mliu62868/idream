import { describe, expect, it, vi } from "vitest";
import { PocketTtsVoiceModel } from "./pocket-tts";

const voiceSynthesisIdentity = {
  requestId: "pocket-test-request",
  attemptNo: 1,
  idempotencyKey: "pocket-test-request:1",
} as const;

describe("PocketTtsVoiceModel", () => {
  it("binds durable speech to its account and verifies the authenticated erasure receipt", async () => {
    const calls: Array<[URL, RequestInit]> = [];
    let acknowledged = true;
    const voice = new PocketTtsVoiceModel({ baseUrl: "http://127.0.0.1:8063/v1", model: "pocket-tts", language: "english", apiKey: "gateway-token",
      fetchImpl: async (endpoint, init) => { calls.push([new URL(String(endpoint)), init!]); return String(endpoint).endsWith("/account-erasure") ? Response.json({ erased: acknowledged }) : new Response(wavBytes(1_000), { headers: { "content-type": "audio/wav" } }); } });
    expect((await voice.synthesize({ ...voiceSynthesisIdentity, ownerId: "private-account", text: "Private speech" })).ok).toBe(true);
    const owner = new Headers(calls[0][1].headers).get("x-idream-owner-hash");
    expect(owner).toMatch(/^[a-f0-9]{64}$/); expect(owner).not.toBe("private-account");
    const erase = { subjectHash: owner!, requestKeys: [voiceSynthesisIdentity.idempotencyKey], voiceIds: ["private-voice"] };
    expect(await voice.eraseAccount(erase)).toEqual({ ok: true, data: { erased: true } });
    expect(calls[1][0].toString()).toBe("http://127.0.0.1:8063/v1/account-erasure");
    expect(new Headers(calls[1][1].headers).get("authorization")).toBe("Bearer gateway-token");
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ subject_hash: owner, request_keys: erase.requestKeys, voice_ids: erase.voiceIds });
    acknowledged = false;
    expect(await voice.eraseAccount(erase)).toMatchObject({ ok: false, error: { code: "invalid_voice_erasure_receipt", retryable: true } });
  });
  it("bounds response-body delivery after the gateway sends its headers", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(wavBytes(1_000)); }, cancel: cancelled });
    const voice = new PocketTtsVoiceModel({ baseUrl: "http://127.0.0.1:8063/v1", model: "pocket-tts", language: "english", timeoutMs: 250,
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "audio/wav" } }) });
    let timer!: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([voice.synthesize({ ...voiceSynthesisIdentity, text: "A reply." }),
        new Promise(resolve => { timer = setTimeout(() => resolve("unbounded response body"), 600); })]);
      expect(result).toMatchObject({ ok: false, error: { code: "voice_timeout", retryable: true } });
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timer); if (!cancelled.mock.calls.length) streamController.close(); }
  });

  it("sends the complete longest accepted reply without dropping its ending", async () => {
    const ending = " The final sentence must be heard aloud.";
    const text = "a".repeat(2_000 - ending.length) + ending;
    const fetchMock = vi.fn(async () => new Response(wavBytes(1_000), { headers: { "content-type": "audio/wav" } }));
    const voice = new PocketTtsVoiceModel({ baseUrl: "http://127.0.0.1:8063/v1", model: "pocket-tts", language: "english", fetchImpl: fetchMock });
    expect((await voice.synthesize({ ...voiceSynthesisIdentity, text })).ok).toBe(true);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1].body)).input).toBe(text);
  });

  it("rejects input beyond the configured bound before invoking the provider", async () => {
    const fetchMock = vi.fn(async () => new Response(wavBytes(1_000), { headers: { "content-type": "audio/wav" } }));
    const voice = new PocketTtsVoiceModel({ baseUrl: "http://127.0.0.1:8063/v1", model: "pocket-tts", language: "english", maxInputChars: 10, fetchImpl: fetchMock });
    expect(await voice.synthesize({ ...voiceSynthesisIdentity, text: "The reply must stay complete." })).toMatchObject({ ok: false, error: { code: "voice_input_too_long", retryable: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["garbage", "truncated", "invalid-frame-rate", "mislabeled"])("rejects %s provider audio instead of estimating billable duration", async fault => {
    const bytes = wavBytes(1_000);
    const body = fault === "garbage" ? new TextEncoder().encode("not playable audio") : fault === "truncated" ? bytes.slice(0, -10) : bytes;
    if (fault === "invalid-frame-rate") new DataView(body.buffer).setUint32(28, 1, true);
    const voice = new PocketTtsVoiceModel({ baseUrl: "http://127.0.0.1:8063/v1", model: "pocket-tts", language: "english",
      fetchImpl: async () => new Response(body, { headers: { "content-type": fault === "mislabeled" ? "audio/mpeg" : "audio/wav" } }) });
    expect(await voice.synthesize({ ...voiceSynthesisIdentity, text: "A reply." })).toMatchObject({ ok: false, error: { code: "invalid_voice_response" } });
  });

  it("reports the official CPU runtime and reusable voice-cloning capability", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "healthy",
        runtime: "pocket_tts",
        runtime_version: "3.0.2",
        acceleration: "cpu",
        voice_cloning: true,
        catalog_ready: true,
        catalog_voices: ["alba", "anna"],
        model_loaded: true,
        model_revision: "pinned-model-revision",
        config_fingerprint: "pinned-config-fingerprint",
        system_voice_ready: true,
      }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      model: "pocket-tts",
      language: "english",
      fetchImpl: fetchMock,
    });

    await expect(voice.inspectCapabilities()).resolves.toEqual({
      ok: true,
      data: {
        voiceCloning: true,
        runtime: "pocket_tts",
        runtimeVersion: "3.0.2",
        acceleration: "cpu",
        catalogVoices: ["alba", "anna"],
      },
    });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8063/v1/health");
    expect(init.method).toBe("GET");
  });

  it("rejects a shallow or downgraded Pocket gateway", async () => {
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      model: "pocket-tts",
      language: "english",
      fetchImpl: async () =>
        Response.json({
          status: "healthy",
          voice_cloning: true,
        }),
    });

    await expect(voice.inspectCapabilities()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_voice_health_response",
        retryable: true,
      },
    });
  });

  it("accepts official Pocket patch upgrades without coupling Main to one patch", async () => {
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      model: "pocket-tts",
      language: "english",
      fetchImpl: async () =>
        Response.json({
          status: "healthy",
          runtime: "pocket_tts",
          runtime_version: "3.0.3",
          acceleration: "cpu",
          voice_cloning: true,
          catalog_ready: true,
          catalog_voices: ["alba", "anna"],
          model_loaded: true,
          model_revision: "pinned-model-revision",
          config_fingerprint: "pinned-config-fingerprint",
          system_voice_ready: true,
        }),
    });

    await expect(voice.inspectCapabilities()).resolves.toEqual({
      ok: true,
      data: {
        voiceCloning: true,
        runtime: "pocket_tts",
        runtimeVersion: "3.0.3",
        acceleration: "cpu",
        catalogVoices: ["alba", "anna"],
      },
    });
  });

  it("accepts a catalog-only runtime when gated cloning weights are absent", async () => {
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      model: "pocket-tts",
      language: "english",
      fetchImpl: async () =>
        Response.json({
          status: "healthy",
          runtime: "pocket_tts",
          runtime_version: "3.0.2",
          acceleration: "cpu",
          voice_cloning: false,
          catalog_ready: true,
          catalog_voices: ["alba", "anna"],
          model_loaded: true,
          model_revision: "pinned-model-revision",
          config_fingerprint: "pinned-config-fingerprint",
          system_voice_ready: true,
        }),
    });

    await expect(voice.inspectCapabilities()).resolves.toEqual({
      ok: true,
      data: {
        voiceCloning: false,
        runtime: "pocket_tts",
        runtimeVersion: "3.0.2",
        acceleration: "cpu",
        catalogVoices: ["alba", "anna"],
      },
    });
  });

  it("creates a reusable Pocket TTS voice from uploaded reference audio", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        voice_id: "idream-voice-1",
        model: "pocket-tts",
        language: "english",
      }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      apiKey: "voice-token",
      model: "pocket-tts",
      language: "english",
      fetchImpl: fetchMock,
    });

    const result = await voice.cloneVoice({
      voiceId: "idream-voice-1",
      audio: new Uint8Array([82, 73, 70, 70]),
      contentType: "audio/wav",
      filename: "reference.wav",
      language: "english",
      referenceText: "This is the exact transcript of the reference recording.",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        voiceId: "idream-voice-1",
        model: "pocket-tts",
        language: "english",
      },
    });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8063/v1/voices");
    expect(init.headers).toEqual({ authorization: "Bearer voice-token" });
    const form = init.body as FormData;
    expect(form.get("voice_id")).toBe("idream-voice-1");
    expect(form.get("language")).toBe("english");
    expect(form.get("ref_text")).toBe(
      "This is the exact transcript of the reference recording.",
    );
    expect(form.get("audio")).toBeInstanceOf(File);
  });

  it("creates a durable role-specific alias from an official catalog voice", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        voice_id: "idream-voice-anna-1",
        preset_voice_id: "anna",
        model: "pocket-tts",
        language: "english",
      }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      apiKey: "voice-token",
      model: "pocket-tts",
      language: "english",
      fetchImpl: fetchMock,
    });

    await expect(voice.createPresetVoice?.({
      voiceId: "idream-voice-anna-1",
      presetVoiceId: "anna",
      language: "english",
    })).resolves.toEqual({
      ok: true,
      data: {
        voiceId: "idream-voice-anna-1",
        presetVoiceId: "anna",
        model: "pocket-tts",
        language: "english",
      },
    });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8063/v1/voices/presets");
    expect(init.headers).toEqual({
      authorization: "Bearer voice-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      voice_id: "idream-voice-anna-1",
      preset_voice_id: "anna",
      language: "english",
    });
  });

  it("renders a cloned voice through the existing chat speech contract", async () => {
    const audio = wavBytes(1_250);
    const fetchMock = vi.fn(async () =>
      new Response(audio, { headers: { "content-type": "audio/wav" } }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      model: "pocket-tts",
      language: "english",
      fetchImpl: fetchMock,
    });

    const result = await voice.synthesize({
      ...voiceSynthesisIdentity,
      text: "Hello from the active character voice.",
      voiceId: "idream-voice-1",
    });

    expect(result).toMatchObject({
      ok: true,
      data: { durationMs: 1_250 },
    });
    expect(result).toMatchObject({ ok: true, data: { contentType: "audio/wav" } });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8063/v1/audio/speech");
    expect(init.headers).toMatchObject({
      "idempotency-key": voiceSynthesisIdentity.idempotencyKey,
      "x-idream-request-id": voiceSynthesisIdentity.requestId,
      "x-idream-attempt-no": String(voiceSynthesisIdentity.attemptNo),
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "pocket-tts",
      input: "Hello from the active character voice.",
      voice: "idream-voice-1",
      response_format: "wav",
    });
  });

  it("previews a built-in female voice without writing a chat clip", async () => {
    const audio = wavBytes(900);
    const fetchMock = vi.fn(async () =>
      new Response(audio, { headers: { "content-type": "audio/wav" } }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8063/v1",
      model: "pocket-tts",
      language: "english",
      fetchImpl: fetchMock,
    });

    await expect(voice.previewVoice({
      text: "Preview the system default female voice.",
      voiceId: "alba",
    })).resolves.toMatchObject({
      ok: true,
      data: {
        body: audio,
        contentType: "audio/wav",
        durationMs: 900,
      },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ voice: "alba" });
  });
});

function wavBytes(durationMs: number) {
  const sampleRate = 8_000;
  const sampleCount = Math.floor((sampleRate * durationMs) / 1_000);
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
