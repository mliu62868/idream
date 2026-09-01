import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/admin";

const voiceProfileState = vi.hoisted(() => ({
  profile: null as {
    provider: string;
    deliverySettings: unknown;
    version: number;
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

vi.mock("@/server/providers", () => ({
  providers: {
    voice: {
      clip: { providerKey: "mock" },
      identity: null,
    },
  },
}));

import {
  FISH_AUDIO_CATALOG,
  POCKET_TTS_CATALOG,
  resolveCharacterVoiceAuthority,
  voiceDefaultSettingsDto,
  voiceIdForGender,
} from "./voice-defaults";

describe("system voice defaults", () => {
  it("uses the official English Pocket catalog for the Pocket system provider", () => {
    const settings = voiceDefaultSettingsDto(null, "pocket_tts");

    expect(settings).toMatchObject({
      provider: "pocket_tts",
      source: "environment",
      defaultVoiceId: "alba",
      genderVoiceIds: {
        female: "alba",
        male: "alba",
        trans: "alba",
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
    expect(voiceIdForGender(settings, "female")).toBe("alba");
    expect(voiceIdForGender(settings, "unknown")).toBe("alba");
    expect(settings.catalog).toEqual(POCKET_TTS_CATALOG);
    expect(settings.catalog).toHaveLength(21);
  });

  it("keeps system fallback speech pinned to the configured provider", async () => {
    voiceProfileState.profile = null;

    await expect(
      resolveCharacterVoiceAuthority({
        characterId: "character-system-default",
        voiceId: null,
        gender: "female",
      }),
    ).resolves.toMatchObject({
      providerKey: "mock",
      voiceId: "default",
      source: "system_default",
    });
  });

  it("exposes one curated female identity instead of fictional speakers", () => {
    expect(FISH_AUDIO_CATALOG).toHaveLength(1);
    expect(
      FISH_AUDIO_CATALOG.every((voice) => voice.presentation === "female"),
    ).toBe(true);
    expect(FISH_AUDIO_CATALOG[0]?.id).toBe("fish-female-default");
  });

  it("rejects the legacy Fish-only setting after the system provider switches to Pocket", () => {
    const settings = voiceDefaultSettingsDto(
      {
        version: 4,
        updatedAt: new Date("2026-08-31T00:00:00.000Z"),
        value: {
          schemaVersion: 2,
          defaultVoiceId: "fish-female-default",
          genderVoiceIds: {
            female: "fish-female-default",
            male: "fish-female-default",
            trans: "fish-female-default",
          },
          delivery: DEFAULT_FISH_AUDIO_DELIVERY,
        },
      },
      "pocket_tts",
    );

    expect(settings).toMatchObject({
      provider: "pocket_tts",
      source: "environment",
      settingVersion: 4,
      defaultVoiceId: "alba",
    });
  });

  it("uses a stored default only when it is pinned to the active provider catalog", () => {
    const settings = voiceDefaultSettingsDto(
      {
        version: 5,
        updatedAt: new Date("2026-08-31T00:00:00.000Z"),
        value: {
          schemaVersion: 3,
          provider: "pocket_tts",
          defaultVoiceId: "anna",
          genderVoiceIds: {
            female: "anna",
            male: "marius",
            trans: "cosette",
          },
          delivery: DEFAULT_FISH_AUDIO_DELIVERY,
        },
      },
      "pocket_tts",
    );

    expect(settings).toMatchObject({
      provider: "pocket_tts",
      source: "app_setting",
      settingVersion: 5,
      defaultVoiceId: "anna",
      genderVoiceIds: {
        female: "anna",
        male: "marius",
        trans: "cosette",
      },
    });
  });

  it("pins an activated Pocket profile to the Pocket runtime", async () => {
    voiceProfileState.profile = {
      provider: "pocket_tts",
      deliverySettings: {},
      version: 1,
    };

    await expect(
      resolveCharacterVoiceAuthority({
        characterId: "character-1",
        voiceId: "idream-pocket-voice",
        gender: "male",
      }),
    ).resolves.toMatchObject({
      providerKey: "pocket_tts",
      voiceId: "idream-pocket-voice",
      source: "character_clone",
      characterVoiceProfileVersion: 1,
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
      version: 3,
    };

    await expect(
      resolveCharacterVoiceAuthority({
        characterId: "character-1",
        voiceId: "idream-fish-voice",
        gender: "female",
      }),
    ).resolves.toMatchObject({
      providerKey: "fish_audio",
      voiceId: "idream-fish-voice",
      source: "character_clone",
      settingVersion: null,
      characterVoiceProfileVersion: 3,
      delivery: {
        preset: "intimate",
        intensity: 62,
      },
    });
  });
});
