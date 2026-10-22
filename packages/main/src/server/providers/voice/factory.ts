import { env } from "@/server/lib/env";
import type { VoiceClipPort, VoiceIdentityPort, VoicePorts, VoiceProviderKey } from "../types";
import { FishAudioVoiceModel } from "./fish-audio";
import { MockVoiceModel } from "./mock";
import { PocketTtsVoiceModel } from "./pocket-tts";

export type { VoiceProviderKey } from "../types";

// SPEC: Runtime, probes, and product modules must exercise the same configured
// adapter construction. Capability checks belong above this internal seam.
export function createConfiguredVoicePorts(): VoicePorts {
  return createVoicePortsForKey(configuredVoiceProviderKey());
}

// INVARIANT: durable VoiceClipRequest rows are executed by their pinned
// provider, even after the process configuration changes. Removing historical
// credentials is therefore an explicit operational cutover, not an implicit
// repin of an already-reserved synthesis request.
export function createVoiceClipPortForKey(
  providerKey: VoiceProviderKey,
): VoiceClipPort {
  return createVoicePortsForKey(providerKey).clip;
}

// INVARIANT: exhaustive over VoiceProviderKey. This used to end in an unguarded
// `return new PipelineVoiceModel(...)`, so any key the branches above did not
// recognise — a typo, or a row pinned to a retired provider — silently became
// the pipeline gateway. Adding a key now fails the build here instead.
export function createVoicePortsForKey(
  providerKey: VoiceProviderKey,
): VoicePorts {
  switch (providerKey) {
    case "mock":
      return { clip: new MockVoiceModel(), identity: null };
    case "pocket_tts": {
      const adapter = new PocketTtsVoiceModel({
        baseUrl: env.POCKET_TTS_API_URL,
        apiKey: env.POCKET_TTS_API_TOKEN,
        model: env.POCKET_TTS_MODEL,
        language: env.POCKET_TTS_LANGUAGE,
        defaultVoiceId: env.POCKET_TTS_DEFAULT_VOICE_ID,
        maxInputChars: env.PIPELINE_VOICE_MAX_INPUT_CHARS,
        timeoutMs: env.POCKET_TTS_TIMEOUT_MS,
      });
      return { clip: adapter, identity: adapter };
    }
    case "fish_audio": {
      const adapter = new FishAudioVoiceModel({
        baseUrl: env.FISH_AUDIO_API_URL,
        apiKey: env.FISH_AUDIO_API_TOKEN,
        model: env.FISH_AUDIO_MODEL,
        language: env.FISH_AUDIO_LANGUAGE,
        defaultVoiceId: env.FISH_AUDIO_DEFAULT_VOICE_ID,
        maxInputChars: env.PIPELINE_VOICE_MAX_INPUT_CHARS,
        timeoutMs: env.FISH_AUDIO_TIMEOUT_MS,
      });
      return { clip: adapter, identity: adapter };
    }
  }
}

export function configuredVoiceProviderKey(): VoiceProviderKey {
  if (env.VOICE_PROVIDER === "pocket-tts") return "pocket_tts";
  if (env.VOICE_PROVIDER === "fish-audio") return "fish_audio";
  return env.VOICE_PROVIDER;
}

export function configuredVoiceModel(providerKey: VoiceProviderKey): string {
  if (providerKey === "pocket_tts") return env.POCKET_TTS_MODEL;
  if (providerKey === "fish_audio") return env.FISH_AUDIO_MODEL;
  return "mock";
}

export async function englishVoiceRuntimeReady(providerKey: VoiceProviderKey, identity = createVoicePortsForKey(providerKey).identity): Promise<boolean> {
  if (providerKey === "mock" || !identity || identity.providerKey !== providerKey) return false;
  const capabilities = await identity.inspectCapabilities();
  return capabilities.ok && voiceRuntimeSupportsEnglish(providerKey, capabilities.data);
}

export function voiceRuntimeSupportsEnglish(providerKey: VoiceProviderKey, capabilities: Extract<Awaited<ReturnType<VoiceIdentityPort["inspectCapabilities"]>>, { ok: true }>["data"]): boolean {
  return providerKey !== "mock" &&
    capabilities.supportedModels?.includes(configuredVoiceModel(providerKey)) === true &&
    capabilities.languages?.some(language => ["en", "english"].includes(language.toLowerCase())) === true;
}
