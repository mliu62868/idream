import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/contracts";
import { FishAudioVoiceModel } from "./fish-audio";

describe("FishAudioVoiceModel", () => {
  it("binds durable speech to its account and verifies the authenticated erasure receipt", async () => {
    const calls: Array<[URL, RequestInit]> = [];
    let acknowledged = true;
    const voice = new FishAudioVoiceModel({ baseUrl: "http://127.0.0.1:8062/v1", model: "fish-audio", language: "auto", apiKey: "gateway-token",
      fetchImpl: async (endpoint, init) => { calls.push([new URL(String(endpoint)), init!]); return String(endpoint).endsWith("/account-erasure") ? Response.json({ erased: acknowledged }) : new Response(wavBytes(1_000), { headers: { "content-type": "audio/wav" } }); } });
    expect((await voice.synthesize({ requestId: "owned", attemptNo: 1, idempotencyKey: "owned", ownerId: "private-account", text: "Private speech", voiceId: "fish-female-default" })).ok).toBe(true);
    const owner = new Headers(calls[0][1].headers).get("x-idream-owner-hash");
    expect(owner).toMatch(/^[a-f0-9]{64}$/); expect(owner).not.toBe("private-account");
    const erase = { subjectHash: owner!, requestKeys: ["owned"], voiceIds: ["private-voice"] };
    expect(await voice.eraseAccount(erase)).toEqual({ ok: true, data: { erased: true } });
    expect(calls[1][0].toString()).toBe("http://127.0.0.1:8062/v1/account-erasure");
    expect(new Headers(calls[1][1].headers).get("authorization")).toBe("Bearer gateway-token");
    acknowledged = false;
    expect(await voice.eraseAccount(erase)).toMatchObject({ ok: false, error: { code: "invalid_voice_erasure_receipt", retryable: true } });
  });
  it("bounds response-body delivery after the gateway sends its headers", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(wavBytes(1_000)); }, cancel: cancelled });
    const voice = new FishAudioVoiceModel({ baseUrl: "http://127.0.0.1:8062/v1", model: "fish-audio", language: "auto", timeoutMs: 250,
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "audio/wav" } }) });
    let timer!: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([voice.previewVoice({ text: "A reply.", voiceId: "fish-female-default" }),
        new Promise(resolve => { timer = setTimeout(() => resolve("unbounded response body"), 600); })]);
      expect(result).toMatchObject({ ok: false, error: { code: "voice_timeout", retryable: true } });
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timer); if (!cancelled.mock.calls.length) streamController.close(); }
  });

  it("reports only the delivery controls applied by the resident gateway", async () => {
    const fetchMock = vi.fn(async () => new Response(wavBytes(1_000), { headers: { "content-type": "audio/wav" } }));
    const voice = new FishAudioVoiceModel({ baseUrl: "http://127.0.0.1:8062/v1", model: "fish-audio", language: "auto", fetchImpl: fetchMock });
    const result = await voice.synthesize({ requestId: "scene-reply", attemptNo: 1, idempotencyKey: "scene-reply:provider", text: "A reply.", tone: "whisper",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
      scene: { version: 1, location: "library", time: "night", participants: [], emotionalBeat: "quiet", unresolvedThreads: [] } });
    expect(result).toMatchObject({ ok: true, data: { sceneApplied: false, sceneAdapter: "fish-audio-delivery-1" } });
    const payload = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1].body));
    expect(payload).toMatchObject({ delivery: DEFAULT_FISH_AUDIO_DELIVERY });
    expect(payload).not.toHaveProperty("scene");
    expect(payload).not.toHaveProperty("scene_instructions");
    expect(payload).not.toHaveProperty("tone");
  });

  it("sends the complete longest accepted reply without dropping its ending", async () => {
    const ending = " The final sentence must be heard aloud.";
    const text = "a".repeat(2_000 - ending.length) + ending;
    const fetchMock = vi.fn(async () => new Response(wavBytes(1_000), { headers: { "content-type": "audio/wav" } }));
    const voice = new FishAudioVoiceModel({ baseUrl: "http://127.0.0.1:8062/v1", model: "fish-audio", language: "auto", fetchImpl: fetchMock });
    expect((await voice.previewVoice({ text, voiceId: "fish-female-default" })).ok).toBe(true);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1].body)).input).toBe(text);
  });

  it("rejects input beyond the configured bound before invoking the provider", async () => {
    const fetchMock = vi.fn(async () => new Response(wavBytes(1_000), { headers: { "content-type": "audio/wav" } }));
    const voice = new FishAudioVoiceModel({ baseUrl: "http://127.0.0.1:8062/v1", model: "fish-audio", language: "auto", maxInputChars: 10, fetchImpl: fetchMock });
    expect(await voice.previewVoice({ text: "The reply must stay complete.", voiceId: "fish-female-default" })).toMatchObject({ ok: false, error: { code: "voice_input_too_long", retryable: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["garbage", "truncated", "invalid-frame-rate", "mislabeled"])("rejects %s provider audio instead of estimating billable duration", async fault => {
    const bytes = wavBytes(1_000);
    const body = fault === "garbage" ? new TextEncoder().encode("not playable audio") : fault === "truncated" ? bytes.slice(0, -10) : bytes;
    if (fault === "invalid-frame-rate") new DataView(body.buffer).setUint32(28, 1, true);
    const voice = new FishAudioVoiceModel({ baseUrl: "http://127.0.0.1:8062/v1", model: "fish-audio", language: "auto",
      fetchImpl: async () => new Response(body, { headers: { "content-type": fault === "mislabeled" ? "audio/mpeg" : "audio/wav" } }) });
    expect(await voice.previewVoice({ text: "A reply.", voiceId: "fish-female-default" })).toMatchObject({ ok: false, error: { code: "invalid_voice_response" } });
  });

  it("requires the resident MLX Audio Fish runtime", async () => {
    const voice = new FishAudioVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "fish-audio-s2-pro-8bit",
      language: "auto",
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

  it("returns identical bytes when the same synthesis attempt is replayed", async () => {
    const voice = new FishAudioVoiceModel({
      baseUrl: "http://127.0.0.1:8062/v1",
      model: "fish-audio-s2-pro-8bit",
      language: "auto",
      fetchImpl: async () =>
        new Response(wavBytes(800), {
          headers: { "content-type": "audio/wav" },
        }),
    });
    const input = {
      requestId: "voice-request-1",
      attemptNo: 1,
      idempotencyKey: "voice-request-1:attempt:1",
      text: "Replay this exact clip.",
    };

    const first = await voice.synthesize(input);
    const replay = await voice.synthesize(input);

    // The adapter no longer names or stores the artifact, so "one key per attempt"
    // is now a property of voiceArtifactKey (see idempotency.test.ts). What this
    // adapter still owes the caller is a byte-identical replay.
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ ok: true, data: { contentType: "audio/wav" } });
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
