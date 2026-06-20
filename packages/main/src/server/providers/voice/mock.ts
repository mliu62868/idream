import type { VoiceModel } from "../types";

export class MockVoiceModel implements VoiceModel {
  async synthesize(input: Parameters<VoiceModel["synthesize"]>[0]) {
    return {
      ok: true as const,
      data: {
        key: `mock/voice/${input.voiceId ?? "default"}.mp3`,
        durationMs: Math.max(500, input.text.length * 35),
      },
    };
  }
}
