import { describe, expect, it } from "vitest";
import {
  POCKET_TTS_CATALOG,
  voiceDefaultSettingsDto,
  voiceIdForGender,
} from "./voice-defaults";

describe("system voice defaults", () => {
  it("uses a female voice for the global and female fallback", () => {
    const settings = voiceDefaultSettingsDto(null);

    expect(settings).toMatchObject({
      provider: "pocket_tts",
      source: "environment",
      defaultVoiceId: "alba",
      genderVoiceIds: {
        female: "alba",
        male: "marius",
        trans: "alba",
      },
    });
    expect(voiceIdForGender(settings, "female")).toBe("alba");
    expect(voiceIdForGender(settings, "unknown")).toBe("alba");
  });

  it("exposes the complete oMLX Pocket TTS catalog with presentation metadata", () => {
    expect(POCKET_TTS_CATALOG).toHaveLength(8);
    expect(POCKET_TTS_CATALOG.filter((voice) => voice.presentation === "female"))
      .toHaveLength(5);
    expect(POCKET_TTS_CATALOG.filter((voice) => voice.presentation === "male"))
      .toHaveLength(3);
  });
});
