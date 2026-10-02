import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/server/lib/env";
import { providers } from "@/server/providers";
import { createVoicePortsForKey } from "@/server/providers/voice/factory";
import { voiceCallStartSchema } from "@idream/shared/contracts";
import { voiceCallAvailability } from "./voice-call";

const previous = { provider: env.VOICE_PROVIDER, language: env.POCKET_TTS_LANGUAGE, asr: env.ASR_PROVIDER, token: env.PARAKEET_ASR_API_TOKEN, voice: providers.voice };
beforeAll(() => {
  env.VOICE_PROVIDER = "pocket-tts"; env.POCKET_TTS_LANGUAGE = "english";
  env.ASR_PROVIDER = "parakeet-redux"; env.PARAKEET_ASR_API_TOKEN = "test-call-token";
  providers.voice = createVoicePortsForKey("pocket_tts");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); env.VOICE_PROVIDER = "pocket-tts"; });
afterAll(() => { env.VOICE_PROVIDER = previous.provider; env.POCKET_TTS_LANGUAGE = previous.language; env.ASR_PROVIDER = previous.asr; env.PARAKEET_ASR_API_TOKEN = previous.token; providers.voice = previous.voice; });
const health = { ready: true, model: "moondream/parakeet-redux", modelRevision: "2bf128600aac4b16946f7ed8372e56117fe5e23b", runtimeVersion: "2.6.1" };
describe("qualified English turn-based Call capability", () => {
  it("requires both resident TTS readiness and the pinned ASR runtime", async () => {
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: true, data: { voiceCloning: false } });
    const fetcher = vi.fn().mockResolvedValue(Response.json(health)); vi.stubGlobal("fetch", fetcher);
    expect(await voiceCallAvailability()).toEqual({ status: "available", language: "en", transport: "turn-based" });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/health"), expect.objectContaining({ cache: "no-store" }));
    fetcher.mockResolvedValue(Response.json({ ...health, modelRevision: "unqualified" }));
    expect((await voiceCallAvailability()).status).toBe("unavailable");
  });
  it("configuration and a healthy ASR cannot mask an unavailable voice model", async () => {
    vi.spyOn(providers.voice.identity!, "inspectCapabilities").mockResolvedValue({ ok: false, error: { code: "offline", message: "offline", retryable: true } });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await voiceCallAvailability()).status).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not enable unsupported Call languages even when both services are ready", async () => {
    env.VOICE_PROVIDER = "fish-audio";
    const inspect = vi.spyOn(providers.voice.identity!, "inspectCapabilities");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect((await voiceCallAvailability()).status).toBe("unavailable");
    expect(inspect).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(voiceCallStartSchema.safeParse({ id: crypto.randomUUID(), clientLeaseToken: crypto.randomUUID(), language: "fr", maxCostDreamcoins: 2 }).success).toBe(false);
  });
  it("does not advertise a local Call when the actual clip route is a different provider", async () => {
    const voice = providers.voice;
    providers.voice = { ...voice, clip: { providerKey: "mock", synthesize: voice.clip.synthesize.bind(voice.clip) } };
    try { expect((await voiceCallAvailability()).status).toBe("unavailable"); }
    finally { providers.voice = voice; }
  });
});
