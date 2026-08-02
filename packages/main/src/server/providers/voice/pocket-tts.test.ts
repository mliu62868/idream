import { describe, expect, it, vi } from "vitest";
import type { BlobStore } from "../types";
import { PocketTtsVoiceModel } from "./pocket-tts";

const voiceSynthesisIdentity = {
  requestId: "pocket-test-request",
  attemptNo: 1,
  idempotencyKey: "pocket-test-request:1",
} as const;

describe("PocketTtsVoiceModel", () => {
  it("reports the oMLX Pocket runtime and reusable voice-cloning capability", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "healthy",
        runtime: "omlx",
        runtime_version: "0.5.3",
        acceleration: "mlx",
        voice_cloning: true,
      }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "pocket-tts-4bit",
      language: "english",
      blob: stubBlobStore(),
      fetchImpl: fetchMock,
    });

    await expect(voice.inspectCapabilities()).resolves.toEqual({
      ok: true,
      data: {
        voiceCloning: true,
        runtime: "omlx",
        runtimeVersion: "0.5.3",
        acceleration: "mlx",
      },
    });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8062/v1/health");
    expect(init.method).toBe("GET");
  });

  it("rejects a legacy Pocket gateway that is not backed by oMLX", async () => {
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "pocket-tts-4bit",
      language: "english",
      blob: stubBlobStore(),
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

  it("accepts oMLX patch upgrades without coupling Main to one patch version", async () => {
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "pocket-tts-4bit",
      language: "english",
      blob: stubBlobStore(),
      fetchImpl: async () =>
        Response.json({
          status: "healthy",
          runtime: "omlx",
          runtime_version: "0.5.4",
          acceleration: "mlx",
          voice_cloning: true,
        }),
    });

    await expect(voice.inspectCapabilities()).resolves.toEqual({
      ok: true,
      data: {
        voiceCloning: true,
        runtime: "omlx",
        runtimeVersion: "0.5.4",
        acceleration: "mlx",
      },
    });
  });

  it("creates a reusable Pocket TTS voice from uploaded reference audio", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        voice_id: "idream-voice-1",
        model: "pocket-tts-4bit",
        language: "english",
      }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      apiKey: "voice-token",
      model: "pocket-tts-4bit",
      language: "english",
      blob: stubBlobStore(),
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
        model: "pocket-tts-4bit",
        language: "english",
      },
    });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8062/v1/voices");
    expect(init.headers).toEqual({ authorization: "Bearer voice-token" });
    const form = init.body as FormData;
    expect(form.get("voice_id")).toBe("idream-voice-1");
    expect(form.get("language")).toBe("english");
    expect(form.get("ref_text")).toBe(
      "This is the exact transcript of the reference recording.",
    );
    expect(form.get("audio")).toBeInstanceOf(File);
  });

  it("renders a cloned voice through the existing chat speech contract", async () => {
    const audio = wavBytes(1_250);
    const fetchMock = vi.fn(async () =>
      new Response(audio, { headers: { "content-type": "audio/wav" } }),
    );
    const stored: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "pocket-tts-4bit",
      language: "english",
      blob: stubBlobStore(stored),
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
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ contentType: "audio/wav" });
    expect(stored[0]?.key).toMatch(/^voice\/.+\.wav$/);
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8062/v1/audio/speech");
    expect(init.headers).toMatchObject({
      "idempotency-key": voiceSynthesisIdentity.idempotencyKey,
      "x-idream-request-id": voiceSynthesisIdentity.requestId,
      "x-idream-attempt-no": String(voiceSynthesisIdentity.attemptNo),
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "pocket-tts-4bit",
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
    const stored: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "pocket-tts-4bit",
      language: "english",
      blob: stubBlobStore(stored),
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
    expect(stored).toHaveLength(0);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ voice: "alba" });
  });
});

function stubBlobStore(
  stored: Array<{ key: string; body: Uint8Array; contentType: string }> = [],
): BlobStore {
  return {
    async putPrivate(input) {
      stored.push(input);
      return {
        ok: true,
        data: { key: input.key, size: input.body.byteLength },
      };
    },
    async signGetUrl() {
      return { ok: true, data: { url: "https://cdn.example.com/voice.wav" } };
    },
    async delete() {
      return { ok: true, data: { deleted: true } };
    },
  };
}

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
