import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FISH_AUDIO_DELIVERY } from "@idream/shared/admin";

const voiceProfileState = vi.hoisted(() => ({
  voiceId: null as string | null,
  gender: "female",
  systemProvider: "mock",
  previewVoice: vi.fn(),
  setting: null as unknown,
  profile: null as {
    provider: string;
    providerVoiceId: string;
    deliverySettings: unknown;
    version: number;
  } | null,
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    async $transaction<T>(read: (tx: unknown) => Promise<T>) {
      return read({
        character: { async findFirst() {
          return { voiceId: voiceProfileState.voiceId, gender: voiceProfileState.gender };
        } },
        characterVoiceProfile: { async findFirst() {
          const profile = voiceProfileState.profile;
          return profile ? {
            ...profile, id: "voice-profile-test", model: "test-model", language: "english", status: "active",
            referenceAsset: { id: "reference-test", metadata: {}, contentType: "audio/wav" },
            previewAsset: null, sampleText: "A voice sample", createdById: "actor-test",
            createdAt: new Date("2026-09-06T00:00:00Z"), archivedAt: null,
          } : null;
        } },
        appSetting: { async findUnique() { return voiceProfileState.setting; } },
      });
    },
    appSetting: { async findUnique() { return voiceProfileState.setting; } },
  },
}));

vi.mock("@/server/providers", () => ({
  providers: {
    voice: {
      clip: { get providerKey() { return voiceProfileState.systemProvider; } },
      identity: null,
    },
  },
}));

vi.mock("@/server/providers/voice/factory", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/providers/voice/factory")>(),
  createVoicePortsForKey: (providerKey: string) => ({
    identity: {
      providerKey,
      previewVoice: (input: unknown) => voiceProfileState.previewVoice(providerKey, input),
    },
  }),
}));

import {
  FISH_AUDIO_CATALOG,
  POCKET_TTS_CATALOG,
  previewVoiceDefault,
  resolveCharacterVoiceAuthority,
  voiceDefaultSettingsDto,
  voiceIdForGender,
} from "./voice-defaults";

describe("system voice defaults", () => {
  beforeEach(() => {
    voiceProfileState.profile = null;
    voiceProfileState.voiceId = null;
    voiceProfileState.gender = "female";
    voiceProfileState.systemProvider = "mock";
    voiceProfileState.setting = null;
    voiceProfileState.previewVoice.mockReset().mockResolvedValue({
      ok: true,
      data: { body: new Uint8Array([1, 2, 3]), contentType: "audio/wav", durationMs: 1_200 },
    });
  });

  it("previews an official Pocket preset when Ming owns the system default", async () => {
    voiceProfileState.systemProvider = "fish_audio";
    await expect(previewVoiceDefault({
      scope: "character_preset",
      provider: "pocket_tts",
      voiceId: "cosette",
      text: "Hello, it is good to meet you.",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    })).resolves.toEqual({
      voiceId: "cosette", contentType: "audio/wav", audioBase64: "AQID", durationMs: 1_200,
    });
    expect(voiceProfileState.previewVoice).toHaveBeenCalledExactlyOnceWith("pocket_tts", {
      providerKey: "pocket_tts", voiceId: "cosette", text: "Hello, it is good to meet you.",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    });
  });

  it("keeps inherited Ming voice previews on the current system provider", async () => {
    voiceProfileState.systemProvider = "fish_audio";
    const voiceId = voiceDefaultSettingsDto(null, "fish_audio").defaultVoiceId;
    await expect(previewVoiceDefault({
      provider: "fish_audio", voiceId, text: "Hello, it is good to meet you.",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    })).resolves.toMatchObject({ voiceId, audioBase64: "AQID" });
    expect(voiceProfileState.previewVoice).toHaveBeenCalledWith("fish_audio", expect.objectContaining({ voiceId }));
  });

  it("still rejects a system preview after the system provider changes", async () => {
    voiceProfileState.systemProvider = "fish_audio";
    await expect(previewVoiceDefault({
      provider: "pocket_tts", voiceId: "cosette", text: "Hello, it is good to meet you.",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    })).rejects.toMatchObject({ status: 409, message: "System voice provider changed before this preview" });
    expect(voiceProfileState.previewVoice).not.toHaveBeenCalled();
  });

  it("still rejects a Pocket voice submitted as a Ming system default", async () => {
    voiceProfileState.systemProvider = "fish_audio";
    await expect(previewVoiceDefault({
      provider: "fish_audio", voiceId: "cosette", text: "Hello, it is good to meet you.",
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    })).rejects.toMatchObject({ status: 400, message: "System voice defaults must use the active provider catalog" });
    expect(voiceProfileState.previewVoice).not.toHaveBeenCalled();
  });

  it.each(["idream-private-alias", "alba"])("rejects non-product Pocket preset %s before synthesis", async (voiceId) => {
    voiceProfileState.systemProvider = "fish_audio";
    await expect(previewVoiceDefault({
      scope: "character_preset", provider: "pocket_tts", voiceId,
      text: "Hello, it is good to meet you.", delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    })).rejects.toThrow();
    expect(voiceProfileState.previewVoice).not.toHaveBeenCalled();
  });

  it("does not allow a character preset preview to select the Ming identity provider", async () => {
    voiceProfileState.systemProvider = "fish_audio";
    await expect(previewVoiceDefault({
      scope: "character_preset", provider: "fish_audio", voiceId: "fish-female-default",
      text: "Hello, it is good to meet you.", delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    })).rejects.toThrow();
    expect(voiceProfileState.previewVoice).not.toHaveBeenCalled();
  });
  it("uses the official English Pocket catalog for the Pocket system provider", () => {
    const settings = voiceDefaultSettingsDto(null, "pocket_tts");

    expect(settings).toMatchObject({
      provider: "pocket_tts",
      source: "environment",
      defaultVoiceId: "anna",
      genderVoiceIds: {
        female: "anna",
        male: "anna",
        trans: "anna",
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
    expect(voiceIdForGender(settings, "female")).toBe("anna");
    expect(voiceIdForGender(settings, "unknown")).toBe("anna");
    expect(settings.catalog).toEqual(POCKET_TTS_CATALOG);
    expect(settings.catalog).toHaveLength(10);
    expect(settings.catalog.every((voice) => voice.presentation === "female")).toBe(true);
  });

  it("drops a stored default that still names a male Pocket voice", () => {
    // alba was the default for every gender before the catalog became female-only.
    const settings = voiceDefaultSettingsDto(
      {
        version: 2,
        updatedAt: new Date("2026-09-06T00:00:00.000Z"),
        value: {
          schemaVersion: 3,
          provider: "pocket_tts",
          defaultVoiceId: "alba",
          genderVoiceIds: { female: "alba", male: "alba", trans: "alba" },
          delivery: DEFAULT_FISH_AUDIO_DELIVERY,
        },
      },
      "pocket_tts",
    );

    expect(settings).toMatchObject({
      source: "environment",
      settingVersion: 2,
      defaultVoiceId: "anna",
      genderVoiceIds: { female: "anna", male: "anna", trans: "anna" },
    });
    expect(settings.catalog.map((voice) => voice.id)).not.toContain("alba");
  });

  it("keeps system fallback speech pinned to the configured provider", async () => {
    voiceProfileState.profile = null;

    await expect(
      resolveCharacterVoiceAuthority({
        characterId: "character-system-default",
      }),
    ).resolves.toMatchObject({
      providerKey: "mock",
      model: "mock",
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
      defaultVoiceId: "anna",
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
            male: "vera",
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
        male: "vera",
        trans: "cosette",
      },
    });
  });

  it("pins an activated Pocket profile to the Pocket runtime", async () => {
    voiceProfileState.voiceId = "idream-pocket-voice";
    voiceProfileState.profile = {
      provider: "pocket_tts",
      providerVoiceId: "idream-pocket-voice",
      deliverySettings: {},
      version: 1,
    };

    await expect(
      resolveCharacterVoiceAuthority({
        characterId: "character-1",
      }),
    ).resolves.toMatchObject({
      providerKey: "pocket_tts",
      model: "test-model",
      voiceId: "idream-pocket-voice",
      source: "character_clone",
      characterVoiceProfileVersion: 1,
      delivery: DEFAULT_FISH_AUDIO_DELIVERY,
    });
  });

  it("uses the activated Fish profile delivery for character speech", async () => {
    voiceProfileState.voiceId = "idream-fish-voice";
    voiceProfileState.profile = {
      provider: "fish_audio",
      providerVoiceId: "idream-fish-voice",
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
      }),
    ).resolves.toMatchObject({
      providerKey: "fish_audio",
      model: "test-model",
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
  it("preserves the system fallback contract for legacy pointers without an active profile", async () => {
    voiceProfileState.voiceId = "legacy-unowned-voice";
    await expect(resolveCharacterVoiceAuthority({ characterId: "legacy-character" })).resolves.toMatchObject({
      currentVoiceId: "legacy-unowned-voice", activeProfile: null,
      source: "system_default", voiceId: "default", characterVoiceProfileVersion: null,
    });
  });

  it("selects the gender default from the current Character snapshot", async () => {
    voiceProfileState.gender = "male";
    voiceProfileState.systemProvider = "pocket_tts";
    voiceProfileState.setting = {
      version: 7, updatedAt: new Date("2026-09-06T00:00:00Z"), value: {
        schemaVersion: 3, provider: "pocket_tts", defaultVoiceId: "eve",
        genderVoiceIds: { female: "anna", male: "vera", trans: "cosette" },
        delivery: DEFAULT_FISH_AUDIO_DELIVERY,
      },
    };
    await expect(resolveCharacterVoiceAuthority({ characterId: "gender-edited-character" })).resolves.toMatchObject({
      source: "system_default", voiceId: "vera", settingVersion: 7,
    });
  });

});
