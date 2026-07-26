import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/admin";

const voiceProfileState = vi.hoisted(() => ({
  profile: null as {
    provider: string;
    deliverySettings: unknown;
  } | null,
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    appSetting: {
      async findUnique() {
        return null;
      },
    },
    characterVoiceProfile: {
      async findFirst() {
        return voiceProfileState.profile;
      },
    },
  },
}));

import {
  FISH_AUDIO_CATALOG,
  resolveCharacterVoiceAuthority,
  voiceDefaultSettingsDto,
  voiceIdForGender,
} from "./voice-defaults";

describe("system voice defaults", () => {
  it("uses the sensual adult female Fish direction for every system fallback", () => {
    const settings = voiceDefaultSettingsDto(null);

    expect(settings).toMatchObject({
      provider: "fish_audio",
      source: "environment",
      defaultVoiceId: "fish-female-default",
      genderVoiceIds: {
        female: "fish-female-default",
        male: "fish-female-default",
        trans: "fish-female-default",
      },
      delivery: {
        preset: "sensual",
        intensity: 75,
        speed: 0.94,
        temperature: 0.72,
        topP: 0.75,
        topK: 30,
        repetitionPenalty: 1.2,
      },
    });
    expect(voiceIdForGender(settings, "female")).toBe("fish-female-default");
    expect(voiceIdForGender(settings, "unknown")).toBe("fish-female-default");
  });

  it("exposes one curated female identity instead of fictional speakers", () => {
    expect(FISH_AUDIO_CATALOG).toHaveLength(1);
    expect(FISH_AUDIO_CATALOG.every((voice) => voice.presentation === "female"))
      .toBe(true);
    expect(FISH_AUDIO_CATALOG[0]?.id).toBe("fish-female-default");
  });

  it("does not send a legacy Pocket voice id to the Fish runtime", async () => {
    voiceProfileState.profile = {
      provider: "pocket_tts",
      deliverySettings: {},
    };

    await expect(resolveCharacterVoiceAuthority({
      characterId: "character-1",
      voiceId: "idream-pocket-voice",
      gender: "male",
    })).resolves.toMatchObject({
      voiceId: "fish-female-default",
      source: "system_default",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    });
  });

  it("uses the activated Fish profile delivery for character speech", async () => {
    voiceProfileState.profile = {
      provider: "fish_audio",
      deliverySettings: {
        ...DEFAULT_FISH_AUDIO_DELIVERY,
        preset: "intimate",
        intensity: 62,
      },
    };

    await expect(resolveCharacterVoiceAuthority({
      characterId: "character-1",
      voiceId: "idream-fish-voice",
      gender: "female",
    })).resolves.toMatchObject({
      voiceId: "idream-fish-voice",
      source: "character_clone",
      settingVersion: null,
      delivery: {
        preset: "intimate",
        intensity: 62,
      },
    });
  });
});
