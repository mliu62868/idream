import { describe, expect, it, vi } from "vitest";
import type { BlobStore } from "../types";
import { PocketTtsVoiceModel } from "./pocket-tts";

describe("PocketTtsVoiceModel", () => {
  it("reports whether the loaded Pocket weights include voice cloning", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "healthy",
        voice_cloning: false,
      }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "kyutai/pocket-tts",
      language: "english",
      blob: stubBlobStore(),
      fetchImpl: fetchMock,
    });

    await expect(voice.inspectCapabilities()).resolves.toEqual({
      ok: true,
      data: { voiceCloning: false },
    });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8062/v1/health");
    expect(init.method).toBe("GET");
  });

  it("creates a reusable Pocket TTS voice from uploaded reference audio", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        voice_id: "idream-voice-1",
        model: "kyutai/pocket-tts",
        language: "english",
      }),
    );
    const voice = new PocketTtsVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      apiKey: "voice-token",
      model: "kyutai/pocket-tts",
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
    });

    expect(result).toEqual({
      ok: true,
      data: {
        voiceId: "idream-voice-1",
        model: "kyutai/pocket-tts",
        language: "english",
      },
    });
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toBe("http://127.0.0.1:8062/v1/voices");
    expect(init.headers).toEqual({ authorization: "Bearer voice-token" });
    const form = init.body as FormData;
    expect(form.get("voice_id")).toBe("idream-voice-1");
    expect(form.get("language")).toBe("english");
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
      model: "kyutai/pocket-tts",
      language: "english",
      blob: stubBlobStore(stored),
      fetchImpl: fetchMock,
    });

    const result = await voice.synthesize({
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
    expect(JSON.parse(String(init.body))).toEqual({
      model: "kyutai/pocket-tts",
      input: "Hello from the active character voice.",
      voice: "idream-voice-1",
      response_format: "wav",
    });
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
