import { env } from "@/server/lib/env";
import type {
  BlobStore,
  VoiceClipPort,
  VoicePorts,
  VoiceProviderKey,
} from "../types";
import { FishAudioVoiceModel } from "./fish-audio";
import { MockVoiceModel } from "./mock";
import { PipelineVoiceModel } from "./pipeline";
import { PocketTtsVoiceModel } from "./pocket-tts";

export type { VoiceProviderKey } from "../types";

// SPEC: Runtime, probes, and product modules must exercise the same configured
// adapter construction. Capability checks belong above this internal seam.
export function createConfiguredVoicePorts(blob: BlobStore): VoicePorts {
  return createVoicePortsForKey(configuredVoiceProviderKey(), blob);
}

// INVARIANT: durable VoiceClipRequest rows are executed by their pinned
// provider, even after the process configuration changes. Removing historical
// credentials is therefore an explicit operational cutover, not an implicit
// repin of an already-reserved synthesis request.
export function createVoiceClipPortForKey(
  providerKey: VoiceProviderKey,
  blob: BlobStore,
): VoiceClipPort {
  return createVoicePortsForKey(providerKey, blob).clip;
}

export function createVoicePortsForKey(
  providerKey: VoiceProviderKey,
  blob: BlobStore,
): VoicePorts {
  if (providerKey === "mock") {
    return { clip: new MockVoiceModel(blob), identity: null };
  }
  if (providerKey === "pocket_tts") {
    const adapter = new PocketTtsVoiceModel({
      baseUrl: env.POCKET_TTS_API_URL,
      apiKey: env.POCKET_TTS_API_TOKEN,
      model: env.POCKET_TTS_MODEL,
      language: env.POCKET_TTS_LANGUAGE,
      defaultVoiceId: env.POCKET_TTS_DEFAULT_VOICE_ID,
      maxInputChars: env.PIPELINE_VOICE_MAX_INPUT_CHARS,
      timeoutMs: env.POCKET_TTS_TIMEOUT_MS,
      blob,
    });
    return { clip: adapter, identity: adapter };
  }
  if (providerKey === "fish_audio") {
    const adapter = new FishAudioVoiceModel({
      baseUrl: env.FISH_AUDIO_API_URL,
      apiKey: env.FISH_AUDIO_API_TOKEN,
      model: env.FISH_AUDIO_MODEL,
      language: env.FISH_AUDIO_LANGUAGE,
      defaultVoiceId: env.FISH_AUDIO_DEFAULT_VOICE_ID,
      maxInputChars: env.PIPELINE_VOICE_MAX_INPUT_CHARS,
      timeoutMs: env.FISH_AUDIO_TIMEOUT_MS,
      blob,
    });
    return { clip: adapter, identity: adapter };
  }
  return {
    clip: new PipelineVoiceModel({
      baseUrl: requiredPipelineVoiceUrl(),
      apiKey: env.PIPELINE_VOICE_API_TOKEN ?? env.PIPELINE_API_TOKEN,
      model: env.PIPELINE_VOICE_MODEL_DEFAULT,
      defaultVoiceId: env.PIPELINE_VOICE_DEFAULT_VOICE_ID,
      sendInstructions: env.PIPELINE_VOICE_SEND_INSTRUCTIONS,
      maxInputCharsPerRequest: env.PIPELINE_VOICE_CHUNK_CHARS,
      maxInputChars: env.PIPELINE_VOICE_MAX_INPUT_CHARS,
      timeoutMs: env.PIPELINE_VOICE_TIMEOUT_MS,
      blob,
    }),
    identity: null,
  };
}

function configuredVoiceProviderKey(): VoiceProviderKey {
  if (env.VOICE_PROVIDER === "pocket-tts") return "pocket_tts";
  if (env.VOICE_PROVIDER === "fish-audio") return "fish_audio";
  return env.VOICE_PROVIDER;
}

function requiredPipelineVoiceUrl() {
  const value = env.PIPELINE_VOICE_API_URL ?? env.PIPELINE_API_URL;
  if (!value?.trim()) {
    throw new Error(
      "PIPELINE_VOICE_API_URL or PIPELINE_API_URL is required when VOICE_PROVIDER=pipeline",
    );
  }
  return value;
}
