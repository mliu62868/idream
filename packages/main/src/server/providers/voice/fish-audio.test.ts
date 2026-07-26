import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/contracts";
import type { BlobStore } from "../types";
import { FishAudioVoiceModel } from "./fish-audio";

describe("FishAudioVoiceModel", () => {
  it("requires the resident MLX Audio Fish runtime", async () => {
    const voice = new FishAudioVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "fish-audio-s2-pro-8bit",
      language: "auto",
      blob: stubBlobStore(),
      fetchImpl: async () =>
        Response.json({
          status: "healthy",
          runtime: "mlx_audio",
          runtime_version: "0.4.5",
          acceleration: "mlx",
          voice_cloning: true,
          model_loaded: true,
          system_voice_ready: true,
        }),
    });

    await expect(voice.inspectCapabilities()).resolves.toEqual({
      ok: true,
      data: {
        voiceCloning: true,
        runtime: "mlx_audio",
        runtimeVersion: "0.4.5",
        acceleration: "mlx",
      },
    });
  });

  it("rejects a runtime without a configured system female reference", async () => {
    const voice = new FishAudioVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "fish-audio-s2-pro-8bit",
      language: "auto",
      blob: stubBlobStore(),
      fetchImpl: async () =>
        Response.json({
          status: "healthy",
          runtime: "mlx_audio",
          runtime_version: "0.4.5",
          acceleration: "mlx",
          voice_cloning: true,
          model_loaded: true,
          system_voice_ready: false,
        }),
    });

    await expect(voice.inspectCapabilities()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_voice_health_response" },
    });
  });

  it("sends the selected sensual delivery controls to Fish Audio", async () => {
    const audio = wavBytes(1_100);
    const fetchMock = vi.fn(async () =>
      new Response(audio, { headers: { "content-type": "audio/wav" } }),
    );
    const voice = new FishAudioVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "fish-audio-s2-pro-8bit",
      language: "auto",
      defaultVoiceId: "fish-female-default",
      blob: stubBlobStore(),
      fetchImpl: fetchMock,
    });

    await expect(
      voice.previewVoice({
        text: "Come closer. I have something just for you.",
        voiceId: "fish-female-default",
        delivery: DEFAULT_FISH_AUDIO_DELIVERY,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { durationMs: 1_100 },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      model: "fish-audio-s2-pro-8bit",
      input: "Come closer. I have something just for you.",
      voice: "fish-female-default",
      response_format: "wav",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    });
  });
});

function stubBlobStore(): BlobStore {
  return {
    async putPrivate(input) {
      return { ok: true, data: { key: input.key, size: input.body.byteLength } };
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
