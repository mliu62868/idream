import type {
  CharacterWorkspaceDetail,
  FishAudioDeliverySettings,
} from "@idream/shared/admin";
import { INDEXTTS_VOICE_MODEL_ID } from "@idream/shared/contracts";
import type { RunCommittedCharacterMutation } from "./character-workspace-permissions";

// SPEC: 角色声音面板的纯逻辑 —— 状态推导、文案选择与请求构造。
// INTENT: 这些规则原本内联在 CharacterVoicePanel 的渲染函数里；抽成纯函数后，
//         幂等签名、默认模型、按钮文案这些「改错一个字就是重复扣费或误导运营」的
//         细节可以脱离 React 单独测试。

export type VoiceData = CharacterWorkspaceDetail["voice"];
export type VoiceProfile = NonNullable<VoiceData["activeProfile"]>;
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export type RunCommittedMutation = RunCommittedCharacterMutation;

// SPEC: the two ways a Character gets its own voice. "official" aliases a Pocket
// catalog voice; "clone" renders a new identity from reference audio.
export type VoiceModel = "official" | "clone";
export type ModelStatus = "ready" | "unavailable" | "inactive" | "cloning_disabled";
export type VoicePreviewScope = "live" | "audition";
export type DirectAction = "preset" | "clone" | "activate";
export type VoiceBusyAction = DirectAction | "reset";

export const AUDITION_MAX_CHARS = 240;

export function formatCatalogVoiceName(voiceId: string) {
  const words = voiceId.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function catalogVoiceLabel(voice: VoiceData, voiceId: string) {
  return (
    voice.systemDefaults.catalog.find((entry) => entry.id === voiceId)?.label ??
    formatCatalogVoiceName(voiceId)
  );
}

export function voiceProfileName(voice: VoiceData, profile: VoiceProfile, t: Translate) {
  return profile.presetVoiceId ? catalogVoiceLabel(voice, profile.presetVoiceId) : t("Cloned voice");
}

export function cloneModelStatus(voice: VoiceData): ModelStatus {
  return voice.provider !== "fish_audio" && voice.provider !== "pocket_tts"
    ? "inactive"
    : voice.cloningAvailable
      ? "ready"
      : voice.runtimeStatus === "ready"
        ? "cloning_disabled"
        : voice.runtimeStatus;
}

// A live clone keeps the clone path open; otherwise lead with instant catalog voices.
export function defaultVoiceModel(
  active: VoiceProfile | null,
  officialStatus: ModelStatus,
): VoiceModel {
  return active && active.presetVoiceId === null
    ? "clone"
    : officialStatus !== "inactive"
      ? "official"
      : "clone";
}

// The official voice this Character sounds like right now, pinned or inherited.
export function livePresetVoiceId(voice: VoiceData) {
  const active = voice.activeProfile;
  return active
    ? active.presetVoiceId
    : voice.systemDefaults.provider === "pocket_tts"
      ? voice.effectiveVoiceId
      : null;
}

export function resolveSelectedPresetVoiceId(
  choice: string | null,
  live: string | null,
  catalogVoiceIds: readonly string[],
) {
  return choice && catalogVoiceIds.includes(choice)
    ? choice
    : live && catalogVoiceIds.includes(live)
      ? live
      : (catalogVoiceIds[0] ?? "");
}

export function archivedVoiceProfiles(voice: VoiceData) {
  return voice.history.filter(
    (profile) => profile.id !== voice.activeProfile?.id && profile.id !== voice.candidateProfile?.id,
  );
}

// Exact authority IDs settle both completed activation and replaced candidates.
// A still-candidate or unknown profile keeps its original recovery identity.
export function terminalVoiceProfileIds(
  active: VoiceProfile | null,
  history: VoiceData["history"],
) {
  return [active, ...history.filter((profile) => profile.status === "archived")]
    .flatMap((profile) => (profile ? [profile.id] : []));
}

export function isTerminalVoiceProfile(voice: VoiceData, profileId: string) {
  return voice.activeProfile?.id === profileId || voice.history.some((profile) =>
    profile.id === profileId && profile.status === "archived");
}

export function cloneReadiness(input: {
  readonly file: File | null;
  readonly referenceText: string;
  readonly sampleText: string;
}) {
  return [
    input.file !== null,
    input.referenceText.trim().length >= 3,
    input.sampleText.trim().length >= 3,
  ];
}

export function defaultCloneSampleText(
  provider: VoiceData["provider"],
  locale: string,
  characterName: string,
) {
  return provider !== "pocket_tts" && locale === "zh"
    ? `靠近一点，我是${characterName}。很高兴让你听见我的声音。`
    : `Come a little closer. I’m ${characterName}. It’s good to hear from you.`;
}

export function defaultPresetSampleText(characterName: string) {
  return `Hello, I’m ${characterName}. It’s good to hear from you.`;
}

export function livePreviewScript(
  provider: VoiceData["systemDefaults"]["provider"],
  locale: string,
  characterName: string,
) {
  return provider !== "pocket_tts" && locale === "zh"
    ? `靠近一点，我是${characterName}。这是系统声音的试听。`
    : `Come a little closer. I’m ${characterName}. This is the system voice preview.`;
}

// reviewKey pins the live authority a reset was opened against: if the live voice
// changes underneath, the review silently lapses.
export function voiceAuthorityReviewKey(characterId: string, voice: VoiceData) {
  return JSON.stringify([
    characterId,
    voice.currentVoiceId,
    voice.activeProfile?.id,
    voice.systemDefaults.provider,
    voice.systemDefaults.settingVersion,
  ]);
}

export function voicePreviewSignature(
  characterId: string,
  voice: VoiceData,
  voiceId: string,
  delivery: FishAudioDeliverySettings,
  text: string,
) {
  return JSON.stringify([
    characterId,
    voice.systemDefaults.provider,
    voice.systemDefaults.settingVersion,
    voiceId,
    delivery,
    text,
  ]);
}

export function voicePreviewRequestBody(input: {
  readonly scope: VoicePreviewScope;
  readonly provider: VoiceData["systemDefaults"]["provider"];
  readonly voiceId: string;
  readonly text: string;
  readonly delivery: FishAudioDeliverySettings;
}) {
  return {
    ...(input.scope === "audition" ? { scope: "character_preset" as const } : {}),
    provider: input.scope === "audition" ? "pocket_tts" as const : input.provider,
    voiceId: input.voiceId,
    text: input.text,
    delivery: input.delivery,
  };
}

export function voiceExpectedAuthority(voice: VoiceData) {
  return {
    expectedActiveProfileId: voice.activeProfile?.id ?? null,
    expectedCurrentVoiceId: voice.currentVoiceId,
  };
}

type ExpectedVoiceAuthority = ReturnType<typeof voiceExpectedAuthority>;

export function voicePresetCreateSignature(
  characterId: string,
  body: { readonly presetVoiceId: string; readonly sampleText: string },
) {
  return `voice-preset:${characterId}:${JSON.stringify(body)}`;
}

export function voiceActivateSignature(
  characterId: string,
  profileId: string,
  expected: ExpectedVoiceAuthority,
) {
  return `voice-activate:${characterId}:${profileId}:${JSON.stringify(expected)}`;
}

export function voiceResetSignature(characterId: string, expected: ExpectedVoiceAuthority) {
  return `voice-reset:${characterId}:${JSON.stringify(expected)}`;
}

export type VoiceCloneDraft = {
  readonly file: File;
  readonly language: string;
  readonly referenceText: string;
  readonly sampleText: string;
  readonly delivery: FishAudioDeliverySettings;
};

export function voiceCloneSignature(characterId: string, draft: VoiceCloneDraft) {
  return `voice-clone:${characterId}:${JSON.stringify({
    audio: [draft.file.name, draft.file.size, draft.file.lastModified],
    language: draft.language,
    referenceText: draft.referenceText.trim(),
    sampleText: draft.sampleText.trim(),
    delivery: draft.delivery,
  })}`;
}

export function voiceCloneForm(draft: VoiceCloneDraft) {
  const form = new FormData();
  form.set("audio", draft.file, draft.file.name);
  form.set("language", draft.language);
  form.set("referenceText", draft.referenceText.trim());
  form.set("sampleText", draft.sampleText.trim());
  form.set("delivery", JSON.stringify(draft.delivery));
  return form;
}

export function cloneResultMessage(replayed: boolean) {
  return replayed
    ? "The existing voice candidate result was recovered."
    : "The voice candidate is ready. Listen to the preview before activation.";
}

export function activationResultMessage(replayed: boolean) {
  return replayed
    ? "The existing voice activation result was recovered."
    : "The selected voice is now active. New conversations use it right away.";
}

export function resetResultMessage(replayed: boolean) {
  return replayed
    ? "The existing reset to system default was recovered."
    : "This character now inherits the system voice default. New conversations use it right away.";
}

export function modelStatusLabel(status: ModelStatus) {
  return {
    ready: "runtime ready",
    unavailable: "voice service unavailable",
    inactive: "voice provider inactive",
    cloning_disabled: "cloning not enabled",
  }[status];
}

export function officialStatusDetail(status: ModelStatus) {
  return {
    ready: null,
    unavailable: "Official voice service is unavailable. Refresh after it recovers.",
    inactive: "Official voices require the Pocket TTS runtime.",
    cloning_disabled: null,
  }[status];
}

export function cloneStatusDetail(provider: VoiceData["provider"], status: ModelStatus) {
  if (status === "ready") return null;
  if (status === "cloning_disabled") return "Voice cloning is not enabled on this model.";
  return voiceRuntimeMessage(provider, status);
}

export function engineLabel(voice: VoiceData) {
  const version = voice.runtimeVersion ?? "";
  if (voice.runtimeEngine === "mlx_audio" || voice.runtimeEngine === "mlx_indextts") return `MLX ${version}`.trim();
  if (voice.runtimeEngine === "pocket_tts") return `Pocket TTS ${version}`.trim();
  return null;
}

export function voiceIdForGender(
  defaults: VoiceData["systemDefaults"],
  gender: CharacterWorkspaceDetail["character"]["gender"],
) {
  return gender === "female" || gender === "male" || gender === "trans"
    ? defaults.genderVoiceIds[gender]
    : defaults.defaultVoiceId;
}

export function voiceRuntimeMessage(
  provider: VoiceData["provider"],
  status: VoiceData["runtimeStatus"],
) {
  if (provider === "pocket_tts") {
    return {
      ready: "Pocket TTS official English voice catalog is ready on CPU.",
      unavailable:
        "Pocket TTS is configured but unavailable. Verify the official model access, Hugging Face authentication, and the resident Pocket TTS process.",
      inactive:
        "Pocket TTS is not the Character voice provider. Set VOICE_PROVIDER=pocket-tts or VOICE_IDENTITY_PROVIDER=pocket-tts and start the Pocket TTS process.",
    }[status];
  }
  return {
    ready: "Local voice cloning through MLX is ready.",
    unavailable:
      "Local voice cloning is unavailable. Verify the configured model, resident MLX process, and reference audio.",
    inactive:
      "Fish Audio is not the Character voice-cloning provider. Set VOICE_IDENTITY_PROVIDER=fish-audio and start the Fish Audio process.",
  }[status];
}

export function voiceReferenceTranscriptHelp(
  provider: VoiceData["provider"],
  model?: string | null,
) {
  if (model === INDEXTTS_VOICE_MODEL_ID) {
    return "This transcript is stored with the IndexTTS reference voice for audit and reproducibility.";
  }
  return provider === "pocket_tts"
    ? "This transcript is stored with the Pocket TTS reference voice for audit and reproducibility."
    : "This transcript is stored with the voice reference and used by Fish Audio when synthesizing.";
}
