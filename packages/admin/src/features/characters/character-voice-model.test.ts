import { INDEXTTS_VOICE_MODEL_ID } from "@idream/shared/contracts";
import { describe, expect, it } from "vitest";
import { hasAdminZh } from "@/components/admin/i18n-dictionary";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import {
  activationResultMessage,
  archivedVoiceProfiles,
  catalogVoiceLabel,
  cloneModelStatus,
  cloneReadiness,
  cloneResultMessage,
  cloneStatusDetail,
  defaultCloneSampleText,
  defaultPresetSampleText,
  defaultVoiceModel,
  engineLabel,
  formatCatalogVoiceName,
  isTerminalVoiceProfile,
  livePresetVoiceId,
  livePreviewScript,
  modelStatusLabel,
  officialStatusDetail,
  resetResultMessage,
  resolveSelectedPresetVoiceId,
  terminalVoiceProfileIds,
  voiceActivateSignature,
  voiceAuthorityReviewKey,
  voiceCloneForm,
  voiceCloneSignature,
  voiceExpectedAuthority,
  voiceIdForGender,
  voicePresetCreateSignature,
  voicePreviewRequestBody,
  voicePreviewSignature,
  voiceProfileName,
  voiceReferenceTranscriptHelp,
  voiceResetSignature,
  voiceRuntimeMessage,
  type ModelStatus,
  type VoiceData,
  type VoiceProfile,
} from "./character-voice-model";

const baseVoice = characterWorkspaceDetail().voice;

function voiceWith(overrides: Partial<VoiceData>): VoiceData {
  return { ...baseVoice, ...overrides };
}

const profile = {
  id: "voice-profile-1",
  version: 2,
  provider: "fish_audio",
  providerVoiceId: "fish-profile-1",
  presetVoiceId: null,
  model: "s2-pro",
  language: "en",
  delivery: baseVoice.systemDefaults.delivery,
  status: "active",
  reference: {
    assetId: "voice-reference-1",
    filename: "reference.wav",
    contentType: "audio/wav",
    sizeBytes: 1_024,
    transcript: "Come a little closer.",
  },
  preview: null,
  sampleText: "Come a little closer.",
  createdById: "actor-1",
  createdAt: "2026-07-30T12:00:00.000Z",
  archivedAt: null,
} satisfies VoiceProfile;

const identity = (value: string) => value;
const statuses: readonly ModelStatus[] = ["ready", "unavailable", "inactive", "cloning_disabled"];

describe("character voice labels", () => {
  it("prefers the catalog label and falls back to a readable voice id", () => {
    const voice = voiceWith({
      systemDefaults: { ...baseVoice.systemDefaults, catalog: [{ id: "anna", label: "Anna (warm)" } as VoiceData["systemDefaults"]["catalog"][number]] },
    });
    expect(catalogVoiceLabel(voice, "anna")).toBe("Anna (warm)");
    expect(catalogVoiceLabel(voice, "soft_whisper")).toBe("Soft whisper");
    expect(formatCatalogVoiceName("eve")).toBe("Eve");
  });

  it("names cloned profiles generically and preset profiles by catalog voice", () => {
    expect(voiceProfileName(baseVoice, profile, identity)).toBe("Cloned voice");
    expect(voiceProfileName(baseVoice, { ...profile, presetVoiceId: "anna" }, identity)).toBe("Anna");
  });
});

describe("character voice state derivation", () => {
  it("derives the clone model status from provider and runtime", () => {
    expect(cloneModelStatus(voiceWith({ provider: "mock" }))).toBe("inactive");
    expect(cloneModelStatus(voiceWith({ provider: "fish_audio", cloningAvailable: true }))).toBe("ready");
    expect(cloneModelStatus(voiceWith({ provider: "pocket_tts", cloningAvailable: false, runtimeStatus: "ready" })))
      .toBe("cloning_disabled");
    expect(cloneModelStatus(voiceWith({ provider: "fish_audio", cloningAvailable: false, runtimeStatus: "unavailable" })))
      .toBe("unavailable");
  });

  it("keeps a live clone on the clone path and otherwise leads with official voices", () => {
    expect(defaultVoiceModel(profile, "ready")).toBe("clone");
    expect(defaultVoiceModel({ ...profile, presetVoiceId: "anna" }, "ready")).toBe("official");
    expect(defaultVoiceModel(null, "unavailable")).toBe("official");
    expect(defaultVoiceModel(null, "inactive")).toBe("clone");
  });

  it("resolves the live preset from the pinned profile or the inherited Pocket default", () => {
    expect(livePresetVoiceId(voiceWith({ activeProfile: { ...profile, presetVoiceId: "anna" } }))).toBe("anna");
    expect(livePresetVoiceId(voiceWith({ activeProfile: profile }))).toBeNull();
    expect(livePresetVoiceId(baseVoice)).toBeNull();
    expect(livePresetVoiceId(voiceWith({
      effectiveVoiceId: "eve",
      systemDefaults: { ...baseVoice.systemDefaults, provider: "pocket_tts" },
    }))).toBe("eve");
  });

  it("selects the operator choice, then the live voice, then the first catalog voice", () => {
    const catalog = ["anna", "eve"];
    expect(resolveSelectedPresetVoiceId("eve", "anna", catalog)).toBe("eve");
    expect(resolveSelectedPresetVoiceId("gone", "anna", catalog)).toBe("anna");
    expect(resolveSelectedPresetVoiceId(null, "gone", catalog)).toBe("anna");
    expect(resolveSelectedPresetVoiceId(null, null, [])).toBe("");
  });

  it("separates archived history from live and candidate profiles", () => {
    const candidate = { ...profile, id: "candidate", status: "candidate" } as const;
    const archived = { ...profile, id: "archived", status: "archived" } as const;
    const voice = voiceWith({
      activeProfile: profile,
      candidateProfile: candidate,
      history: [profile, candidate, archived],
    });
    expect(archivedVoiceProfiles(voice).map((entry) => entry.id)).toEqual(["archived"]);
    expect(terminalVoiceProfileIds(voice.activeProfile, voice.history)).toEqual([profile.id, "archived"]);
    expect(terminalVoiceProfileIds(null, [candidate])).toEqual([]);
    expect(isTerminalVoiceProfile(voice, profile.id)).toBe(true);
    expect(isTerminalVoiceProfile(voice, "archived")).toBe(true);
    expect(isTerminalVoiceProfile(voice, "candidate")).toBe(false);
  });

  it("counts clone inputs that are ready", () => {
    const file = new File(["audio"], "reference.wav");
    expect(cloneReadiness({ file: null, referenceText: " ab ", sampleText: "" })).toEqual([false, false, false]);
    expect(cloneReadiness({ file, referenceText: "abc", sampleText: "  hello " })).toEqual([true, true, true]);
  });
});

describe("character voice scripts", () => {
  it("localizes clone and live preview scripts only for non-Pocket providers", () => {
    expect(defaultCloneSampleText("fish_audio", "zh", "Mira")).toBe("靠近一点，我是Mira。很高兴让你听见我的声音。");
    expect(defaultCloneSampleText("pocket_tts", "zh", "Mira"))
      .toBe("Come a little closer. I’m Mira. It’s good to hear from you.");
    expect(livePreviewScript("fish_audio", "zh", "Mira")).toBe("靠近一点，我是Mira。这是系统声音的试听。");
    expect(livePreviewScript("fish_audio", "en", "Mira"))
      .toBe("Come a little closer. I’m Mira. This is the system voice preview.");
    expect(defaultPresetSampleText("Mira")).toBe("Hello, I’m Mira. It’s good to hear from you.");
  });
});

describe("character voice request construction", () => {
  const characterId = "character-1";

  it("pins review and preview identity to the live authority", () => {
    const voice = voiceWith({ currentVoiceId: "voice-1", activeProfile: profile });
    expect(voiceAuthorityReviewKey(characterId, voice))
      .toBe(JSON.stringify([characterId, "voice-1", profile.id, "fish_audio", 1]));
    expect(voicePreviewSignature(characterId, voice, "anna", voice.systemDefaults.delivery, "live"))
      .toBe(JSON.stringify([characterId, "fish_audio", 1, "anna", voice.systemDefaults.delivery, "live"]));
  });

  it("builds stable idempotency signatures for every voice write", () => {
    const expected = voiceExpectedAuthority(voiceWith({ currentVoiceId: "voice-1", activeProfile: profile }));
    expect(expected).toEqual({ expectedActiveProfileId: profile.id, expectedCurrentVoiceId: "voice-1" });
    expect(voiceExpectedAuthority(baseVoice)).toEqual({ expectedActiveProfileId: null, expectedCurrentVoiceId: null });
    expect(voicePresetCreateSignature(characterId, { presetVoiceId: "anna", sampleText: "Hello" }))
      .toBe('voice-preset:character-1:{"presetVoiceId":"anna","sampleText":"Hello"}');
    expect(voiceActivateSignature(characterId, "profile-9", expected))
      .toBe(`voice-activate:character-1:profile-9:${JSON.stringify(expected)}`);
    expect(voiceResetSignature(characterId, expected))
      .toBe(`voice-reset:character-1:${JSON.stringify(expected)}`);
  });

  it("trims clone text in both the signature and the multipart form", () => {
    const file = new File(["audio"], "reference.wav", { lastModified: 42 });
    const draft = {
      file,
      language: "en",
      referenceText: "  spoken words  ",
      sampleText: " hello there ",
      delivery: baseVoice.systemDefaults.delivery,
    };
    expect(voiceCloneSignature(characterId, draft)).toBe(`voice-clone:character-1:${JSON.stringify({
      audio: ["reference.wav", file.size, 42],
      language: "en",
      referenceText: "spoken words",
      sampleText: "hello there",
      delivery: draft.delivery,
    })}`);
    const form = voiceCloneForm(draft);
    expect((form.get("audio") as File).name).toBe("reference.wav");
    expect(form.get("language")).toBe("en");
    expect(form.get("referenceText")).toBe("spoken words");
    expect(form.get("sampleText")).toBe("hello there");
    expect(form.get("delivery")).toBe(JSON.stringify(draft.delivery));
  });

  it("routes official auditions through the Pocket character preset scope", () => {
    const delivery = baseVoice.systemDefaults.delivery;
    expect(voicePreviewRequestBody({ scope: "audition", provider: "fish_audio", voiceId: "anna", text: "Hi there", delivery }))
      .toEqual({ scope: "character_preset", provider: "pocket_tts", voiceId: "anna", text: "Hi there", delivery });
    expect(voicePreviewRequestBody({ scope: "live", provider: "fish_audio", voiceId: "fish-1", text: "Hi there", delivery }))
      .toEqual({ provider: "fish_audio", voiceId: "fish-1", text: "Hi there", delivery });
  });

  it("uses the gender default voice for a reset when one exists", () => {
    const defaults = {
      ...baseVoice.systemDefaults,
      defaultVoiceId: "neutral",
      genderVoiceIds: { female: "f", male: "m", trans: "t" },
    };
    expect(voiceIdForGender(defaults, "female")).toBe("f");
    expect(voiceIdForGender(defaults, "male")).toBe("m");
    expect(voiceIdForGender(defaults, "trans")).toBe("t");
    expect(voiceIdForGender(defaults, null as unknown as "female")).toBe("neutral");
  });
});

describe("character voice copy selection", () => {
  it("chooses the recovered or fresh result message", () => {
    expect(cloneResultMessage(true)).toBe("The existing voice candidate result was recovered.");
    expect(cloneResultMessage(false)).toBe("The voice candidate is ready. Listen to the preview before activation.");
    expect(activationResultMessage(true)).toBe("The existing voice activation result was recovered.");
    expect(activationResultMessage(false)).toBe("The selected voice is now active. New conversations use it right away.");
    expect(resetResultMessage(true)).toBe("The existing reset to system default was recovered.");
    expect(resetResultMessage(false))
      .toBe("This character now inherits the system voice default. New conversations use it right away.");
  });

  it("explains runtime and status details per provider", () => {
    expect(officialStatusDetail("ready")).toBeNull();
    expect(officialStatusDetail("inactive")).toBe("Official voices require the Pocket TTS runtime.");
    expect(cloneStatusDetail("fish_audio", "ready")).toBeNull();
    expect(cloneStatusDetail("fish_audio", "cloning_disabled")).toBe("Voice cloning is not enabled on this model.");
    expect(cloneStatusDetail("pocket_tts", "unavailable")).toBe(voiceRuntimeMessage("pocket_tts", "unavailable"));
    expect(engineLabel(voiceWith({ runtimeEngine: "pocket_tts", runtimeVersion: "1.2" }))).toBe("Pocket TTS 1.2");
    expect(engineLabel(voiceWith({ runtimeEngine: "mlx_audio", runtimeVersion: null }))).toBe("MLX");
    expect(engineLabel(baseVoice)).toBeNull();
    expect(voiceReferenceTranscriptHelp("pocket_tts")).toContain("Pocket TTS reference voice");
    expect(voiceReferenceTranscriptHelp("fish_audio")).toContain("used by Fish Audio");
  });

  // INVARIANT: 这些文案从 .tsx 搬进了纯模块，i18n 覆盖测试不再扫描到它们；在这里补上。
  it("has a Chinese translation for every copy the voice model can return", () => {
    const copy = [
      voiceProfileName(baseVoice, profile, identity),
      cloneResultMessage(true),
      cloneResultMessage(false),
      activationResultMessage(true),
      activationResultMessage(false),
      resetResultMessage(true),
      resetResultMessage(false),
      ...statuses.map(modelStatusLabel),
      ...statuses.flatMap((status) => [officialStatusDetail(status)]),
      ...(["fish_audio", "pocket_tts"] as const).flatMap((provider) => [
        ...statuses.map((status) => cloneStatusDetail(provider, status)),
        voiceReferenceTranscriptHelp(provider),
      ]),
      voiceReferenceTranscriptHelp("fish_audio", INDEXTTS_VOICE_MODEL_ID),
    ].filter((value): value is string => value !== null);
    expect(copy.filter((value) => !hasAdminZh(value))).toEqual([]);
  });
});
