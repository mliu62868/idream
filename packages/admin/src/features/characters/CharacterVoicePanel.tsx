"use client";

import {
  DEFAULT_FISH_AUDIO_DELIVERY,
  type SystemVoiceCatalogVoiceId,
  type FishAudioDeliverySettings,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import {
  AudioLines,
  Check,
  CheckCircle2,
  History,
  ListMusic,
  Mic,
  Play,
  RotateCcw,
  Save,
  Settings2,
  Upload,
} from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { RequestErrorDetails } from "@/components/admin/ui/RequestErrorDetails";
import { operatorErrorCopy, type OperatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { cn } from "@/lib/utils";

type RunCommittedMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;

type VoiceData = CharacterWorkspaceDetail["voice"];
type VoiceProfile = NonNullable<VoiceData["activeProfile"]>;
type VoiceDefaultDraft = Pick<VoiceData["systemDefaults"],
  "settingVersion" | "provider" | "defaultVoiceId" | "genderVoiceIds" | "delivery" | "catalog">;
type Translate = (key: string, values?: Record<string, string | number>) => string;

// SPEC: the two ways a Character gets its own voice. "official" aliases a Pocket
// catalog voice; "clone" renders a new identity from reference audio.
type VoiceModel = "official" | "clone";
type ModelStatus = "ready" | "unavailable" | "inactive" | "cloning_disabled";

// SPEC: picking, cloning and activating a voice apply on click. No write asks for a
// reason. Only two writes reach beyond this pick and get a ConfirmDialog: reset
// drops this Character's own voice, and defaults changes every inheriting Character.
// reviewKey pins the live authority a reset was opened against: if the live voice
// changes underneath, the review silently lapses.
type DialogIntent =
  | { readonly kind: "reset"; readonly reviewKey: string }
  | { readonly kind: "defaults"; readonly draft: VoiceDefaultDraft; readonly reviewKey: null };
type DirectAction = "preset" | "clone" | "activate";

const AUDITION_MAX_CHARS = 240;

export function CharacterVoicePanel({
  data,
  canWrite,
  canActivate,
  canManageDefaults,
  canPreview,
  runCommittedMutation,
  takeIdempotencyKey,
  releaseIdempotencyKey,
}: {
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  canActivate: boolean;
  canManageDefaults: boolean;
  canPreview: boolean;
  runCommittedMutation: RunCommittedMutation;
  /**
   * SPEC: 同一个业务签名跨刷新拿到同一个幂等键；写入落地后由 afterRefresh 释放。
   * INTENT: 这四处原本每次点击现开一个 crypto.randomUUID()，于是一次网络抖动后的重试就是
   *         第二次真实写入 —— 声音克隆会重复扣费，激活/重置会重复改线上音色。
   */
  takeIdempotencyKey: (signature: string) => string;
  releaseIdempotencyKey: (signature: string) => void;
}) {
  const { t, locale } = useAdminI18n();
  const voice = data.voice;
  const active = voice.activeProfile;
  const candidate = voice.candidateProfile;
  const catalogLabel = (voiceId: string) =>
    voice.systemDefaults.catalog.find((entry) => entry.id === voiceId)?.label ??
    formatCatalogVoiceName(voiceId);
  const profileName = (profile: VoiceProfile) =>
    profile.presetVoiceId ? catalogLabel(profile.presetVoiceId) : t("Cloned voice");

  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [sampleText, setSampleText] = useState(
    voice.provider !== "pocket_tts" && locale === "zh"
      ? `靠近一点，我是${data.character.name}。很高兴让你听见我的声音。`
      : `Come a little closer. I’m ${data.character.name}. It’s good to hear from you.`,
  );
  const [cloneDelivery, setCloneDelivery] = useState<FishAudioDeliverySettings>({
    ...DEFAULT_FISH_AUDIO_DELIVERY,
  });

  const officialStatus: ModelStatus = voice.presetRuntime.runtimeStatus;
  const cloneStatus: ModelStatus =
    voice.provider !== "fish_audio" && voice.provider !== "pocket_tts"
      ? "inactive"
      : voice.cloningAvailable
        ? "ready"
        : voice.runtimeStatus === "ready"
          ? "cloning_disabled"
          : voice.runtimeStatus;
  // A live clone keeps the clone path open; otherwise lead with instant catalog voices.
  const defaultModel: VoiceModel =
    active && active.presetVoiceId === null
      ? "clone"
      : officialStatus !== "inactive"
        ? "official"
        : "clone";
  const [modelChoice, setModelChoice] = useState<VoiceModel | null>(null);
  const model = modelChoice ?? defaultModel;

  const catalogVoiceIds = voice.presetRuntime.catalogVoiceIds;
  // The official voice this Character sounds like right now, pinned or inherited.
  const livePresetVoiceId = active
    ? active.presetVoiceId
    : voice.systemDefaults.provider === "pocket_tts"
      ? voice.effectiveVoiceId
      : null;
  const [presetChoice, setPresetChoice] = useState<string | null>(null);
  const selectedPresetVoiceId =
    presetChoice && catalogVoiceIds.includes(presetChoice)
      ? presetChoice
      : livePresetVoiceId && catalogVoiceIds.includes(livePresetVoiceId)
        ? livePresetVoiceId
        : (catalogVoiceIds[0] ?? "");
  const [presetSampleText, setPresetSampleText] = useState(
    `Hello, I’m ${data.character.name}. It’s good to hear from you.`,
  );
  // One-click apply creates a candidate and then activates it. If activation fails
  // after the candidate committed, a retry of the same apply resumes at activation.
  const preparedPreset = useRef<{ signature: string; profileId: string } | null>(null);

  const authorityReviewKey = JSON.stringify([
    data.character.id,
    voice.currentVoiceId,
    active?.id,
    voice.systemDefaults.provider,
    voice.systemDefaults.settingVersion,
  ]);
  const [dialog, setDialog] = useState<DialogIntent | null>(null);

  const [defaultDraftOverride, setDefaultDraftOverride] = useState<VoiceDefaultDraft | null>(null);
  const defaultDraft: VoiceDefaultDraft = defaultDraftOverride ?? voice.systemDefaults;
  const defaultDraftStale = defaultDraft.provider !== voice.systemDefaults.provider ||
    defaultDraft.settingVersion !== voice.systemDefaults.settingVersion;
  const [previewBusy, setPreviewBusy] = useState<SystemVoiceCatalogVoiceId | null>(null);
  const [catalogPreview, setCatalogPreview] = useState<{
    voiceId: SystemVoiceCatalogVoiceId;
    src: string;
    scope: "live" | "draft" | "audition";
    signature: string;
  } | null>(null);
  const [busyAction, setBusyAction] = useState<"clone" | "preset" | "activate" | "defaults" | "reset" | null>(null);
  const busy = busyAction !== null;
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: "live" | "draft" | "audition"; text: string } | null>(null);
  const [actionError, setActionError] = useState<{ action: DirectAction; copy: OperatorErrorCopy } | null>(null);

  const archivedProfiles = voice.history.filter(
    (profile) => profile.id !== active?.id && profile.id !== candidate?.id,
  );
  const cloneReadiness = [
    file !== null,
    referenceText.trim().length >= 3,
    sampleText.trim().length >= 3,
  ];
  const cloneReadyCount = cloneReadiness.filter(Boolean).length;
  const cloneProviderLabel = voiceProviderLabel(voice.provider);
  const activationProviderAvailable = voice.candidateRuntimeStatus === "ready";
  const liveProvider = active?.provider ?? voice.systemDefaults.provider;
  const liveVoiceName = active ? profileName(active) : catalogLabel(voice.effectiveVoiceId);
  const livePreviewSignature = previewSignature(voice.effectiveVoiceId, voice.systemDefaults.delivery, "live");
  const auditionText = presetSampleText.trim();
  const selectedIsLiveOverride =
    active !== null && active.presetVoiceId === selectedPresetVoiceId;
  const officialApplyReady =
    canWrite &&
    officialStatus === "ready" &&
    selectedPresetVoiceId.length > 0 &&
    auditionText.length >= 3 &&
    !selectedIsLiveOverride;

  function previewSignature(voiceId: string, delivery: FishAudioDeliverySettings, text: string) {
    return JSON.stringify([
      data.character.id,
      voice.systemDefaults.provider,
      voice.systemDefaults.settingVersion,
      voiceId,
      delivery,
      text,
    ]);
  }

  async function previewCatalogVoice(
    voiceId: SystemVoiceCatalogVoiceId,
    scope: "live" | "draft" | "audition" = "draft",
  ) {
    if (!canPreview || previewBusy || busy || (scope === "draft" && defaultDraftStale)) return;
    const delivery = scope === "draft" ? defaultDraft.delivery : voice.systemDefaults.delivery;
    const text = scope === "audition"
      ? auditionText
      : voice.systemDefaults.provider !== "pocket_tts" && locale === "zh"
        ? `靠近一点，我是${data.character.name}。这是系统声音的试听。`
        : `Come a little closer. I’m ${data.character.name}. This is the system voice preview.`;
    if (text.length < 3) return;
    const signature = previewSignature(voiceId, delivery, scope === "audition" ? text : scope);
    setPreviewBusy(voiceId);
    setError(null);
    try {
      const preview = await adminV2Operation("POST /api/v2/admin/voice-defaults/preview", {
        body: { provider: voice.systemDefaults.provider, voiceId, text, delivery },
      });
      setCatalogPreview({
        voiceId,
        scope,
        signature,
        src: `data:${preview.contentType};base64,${preview.audioBase64}`,
      });
    } catch (cause) {
      setError({
        scope,
        text: cause instanceof Error ? cause.message : "The system voice preview could not be rendered",
      });
    } finally {
      setPreviewBusy(null);
    }
  }

  function auditionOfficialVoice(voiceId: string) {
    setPresetChoice(voiceId);
    void previewCatalogVoice(voiceId, "audition");
  }

  // Direct writes have no dialog to hold a failure, so it renders beside the control.
  async function runDirectAction(action: DirectAction, write: () => Promise<void>) {
    if (busy) return;
    setBusyAction(action);
    setMessage(null);
    setActionError(null);
    try {
      await write();
    } catch (cause) {
      setActionError({ action, copy: operatorErrorCopy(cause) });
    } finally {
      setBusyAction(null);
    }
  }

  // `activate` is read at click time: the write lock revokes permissions mid-write,
  // and the outcome must follow what the operator clicked.
  function applyOfficialVoice(voiceId: string, activate: boolean) {
    return runDirectAction("preset", async () => {
      const body = { presetVoiceId: voiceId, sampleText: auditionText };
      const createSignature = `voice-preset:${data.character.id}:${JSON.stringify(body)}`;
      const expectedAuthority = {
        expectedActiveProfileId: active?.id ?? null,
        expectedCurrentVoiceId: voice.currentVoiceId,
      };
      let profileId = preparedPreset.current?.signature === createSignature
        ? preparedPreset.current.profileId
        : null;
      if (!profileId) {
        const created = await runCommittedMutation({
          action: "Create Pocket TTS voice candidate",
          commit: () =>
            adminV2Operation("POST /api/v2/admin/characters/:id/voice-presets", {
              path: { id: data.character.id },
              replayIdempotencyKey: takeIdempotencyKey(createSignature),
              body,
            }),
          afterRefresh: () => releaseIdempotencyKey(createSignature),
        });
        profileId = created.result.profile.id;
        preparedPreset.current = { signature: createSignature, profileId };
      }
      if (!activate) {
        preparedPreset.current = null;
        setMessage("Candidate submitted. It takes effect after a teammate with publish permission activates it.");
        return;
      }
      const activateSignature =
        `voice-activate:${data.character.id}:${profileId}:${JSON.stringify(expectedAuthority)}`;
      const createdProfileId = profileId;
      await runCommittedMutation({
        action: "Activate Pocket TTS voice",
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/voice-profiles/:profileId/activate", {
            path: { id: data.character.id, profileId: createdProfileId },
            replayIdempotencyKey: takeIdempotencyKey(activateSignature),
            body: expectedAuthority,
          }),
        afterRefresh: () => releaseIdempotencyKey(activateSignature),
      });
      preparedPreset.current = null;
      setPresetChoice(null);
      setMessage(t("Voice changed. New chat speech now uses {voice}.", { voice: catalogLabel(voiceId) }));
    });
  }

  function createClone() {
    if (!file) return;
    return runDirectAction("clone", async () => {
      const form = new FormData();
      form.set("audio", file, file.name);
      form.set("language", voice.runtimeLanguage);
      form.set("referenceText", referenceText.trim());
      form.set("sampleText", sampleText.trim());
      form.set("delivery", JSON.stringify(cloneDelivery));
      const signature = `voice-clone:${data.character.id}:${JSON.stringify({
        audio: [file.name, file.size, file.lastModified],
        language: voice.runtimeLanguage,
        referenceText: referenceText.trim(),
        sampleText: sampleText.trim(),
        delivery: cloneDelivery,
      })}`;
      const mutation = await runCommittedMutation({
        action: `${cloneProviderLabel} voice clone`,
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/voice-clones", {
            path: { id: data.character.id },
            replayIdempotencyKey: takeIdempotencyKey(signature),
            form,
          }),
        afterRefresh: () => {
          releaseIdempotencyKey(signature);
          setFile(null);
          setReferenceText("");
          if (fileInput.current) fileInput.current.value = "";
        },
      });
      setMessage(
        mutation.result.replayed
          ? "The existing voice candidate result was recovered."
          : "The voice candidate is ready. Listen to the preview before activation.",
      );
    });
  }

  function activateCandidate() {
    if (!candidate) return;
    return runDirectAction("activate", async () => {
      const body = {
        expectedActiveProfileId: active?.id ?? null,
        expectedCurrentVoiceId: voice.currentVoiceId,
      };
      const signature = `voice-activate:${data.character.id}:${candidate.id}:${JSON.stringify(body)}`;
      const mutation = await runCommittedMutation({
        action: `Activate ${voiceProviderLabel(candidate.provider)} voice`,
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/voice-profiles/:profileId/activate", {
            path: { id: data.character.id, profileId: candidate.id },
            replayIdempotencyKey: takeIdempotencyKey(signature),
            body,
          }),
        afterRefresh: () => releaseIdempotencyKey(signature),
      });
      setMessage(
        mutation.result.replayed
          ? "The existing voice activation result was recovered."
          : "The selected voice is now active for new chat speech.",
      );
    });
  }

  // Dialog actions throw so ConfirmDialog stays open and shows the failure.
  async function resetToSystemDefault() {
    if (!canActivate || busy || voice.currentVoiceId === null) return;
    setBusyAction("reset");
    setMessage(null);
    const body = {
      expectedActiveProfileId: active?.id ?? null,
      expectedCurrentVoiceId: voice.currentVoiceId,
    };
    const signature = `voice-reset:${data.character.id}:${JSON.stringify(body)}`;
    try {
      const mutation = await runCommittedMutation({
        action: "Reset character voice to system default",
        commit: () =>
          adminV2Operation("POST /api/v2/admin/characters/:id/voice-defaults/reset", {
            path: { id: data.character.id },
            replayIdempotencyKey: takeIdempotencyKey(signature),
            body,
          }),
        afterRefresh: () => releaseIdempotencyKey(signature),
      });
      setMessage(
        mutation.result.replayed
          ? "The existing reset to system default was recovered."
          : "This character now inherits the system voice default.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function saveSystemDefaults(draft: VoiceDefaultDraft) {
    if (!canManageDefaults) {
      throw new Error(t("You no longer have permission to change system voice defaults."));
    }
    if (busy) return;
    setBusyAction("defaults");
    setMessage(null);
    const body = {
      expectedVersion: draft.settingVersion,
      provider: draft.provider,
      defaultVoiceId: draft.defaultVoiceId,
      genderVoiceIds: draft.genderVoiceIds,
      delivery: draft.delivery,
    };
    const signature = `voice-system-defaults:${JSON.stringify(body)}`;
    try {
      const mutation = await runCommittedMutation({
        action: "Update system voice defaults",
        commit: () =>
          adminV2Operation("PUT /api/v2/admin/voice-defaults", {
            replayIdempotencyKey: takeIdempotencyKey(signature),
            body,
          }),
        afterRefresh: () => {
          releaseIdempotencyKey(signature);
          setDefaultDraftOverride(null);
        },
      });
      setMessage(
        mutation.result.replayed
          ? "The saved system voice defaults were recovered."
          : "System voice defaults were saved. New speech now uses this mapping.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  function submitClone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cloneReadyCount !== cloneReadiness.length) return;
    void createClone();
  }

  const dialogOpen = dialog !== null &&
    (dialog.reviewKey === null || dialog.reviewKey === authorityReviewKey);
  const dialogSpec = dialog && dialogOpen ? dialogSpecFor(dialog) : null;

  function dialogSpecFor(intent: DialogIntent): ConfirmSpec {
    const close = () => setDialog(null);
    switch (intent.kind) {
      case "reset":
        return {
          title: "Use system default voice",
          summary: (
            <p>
              {t("{character} goes back to inheriting the system default voice {voice}.", {
                character: data.character.name,
                voice: catalogLabel(
                  voiceIdForGender(voice.systemDefaults, data.character.gender),
                ),
              })}
            </p>
          ),
          requireReason: false,
          submitLabel: "Use system default voice",
          onSubmit: async () => {
            await resetToSystemDefault();
            close();
          },
        };
      case "defaults": {
        const draft = intent.draft;
        return {
          title: "Save system voice defaults",
          summary: (
            <div className="space-y-2">
              <p>{t("Provider")}: {voiceProviderLabel(draft.provider)} · {t("Settings version")}: {draft.settingVersion}</p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
                {([
                  ["System fallback identity", draft.defaultVoiceId],
                  ["Female character default", draft.genderVoiceIds.female],
                  ["Male character default", draft.genderVoiceIds.male],
                  ["Trans character default", draft.genderVoiceIds.trans],
                ] as const).map(([label, voiceId]) => (
                  <div className="contents" key={label}>
                    <dt>{t(label)}</dt>
                    <dd className="font-semibold">{t(draft.catalog.find((entry) => entry.id === voiceId)?.label ?? voiceId)}</dd>
                  </div>
                ))}
              </dl>
              {draft.provider === "fish_audio" ? <VoiceDeliverySummary delivery={draft.delivery} t={t} /> : null}
              <p>
                {t("This is a platform-wide setting. It changes new speech for every character that has no voice override, not just this one.")}
              </p>
              <p>
                {t("Characters with an activated voice keep it. Already generated audio is not replaced.")}
              </p>
            </div>
          ),
          requireReason: false,
          submitLabel: "Save system defaults",
          onSubmit: async () => {
            await saveSystemDefaults(draft);
            close();
          },
        };
      }
    }
  }

  const liveAudio = active?.preview ? (
    <audio
      aria-label={t("Active character voice preview")}
      className="h-10 w-full sm:w-72"
      controls
      preload="metadata"
      src={active.preview.url}
    />
  ) : catalogPreview?.scope === "live" && catalogPreview.signature === livePreviewSignature ? (
    <audio
      aria-label={t("System voice preview")}
      autoPlay
      className="h-10 w-full sm:w-72"
      controls
      src={catalogPreview.src}
    />
  ) : (
    // An override's effective id is a private alias the catalog preview cannot render.
    <WorkspaceButton
      disabled={active !== null || !canPreview || previewBusy !== null || busy}
      onClick={() => void previewCatalogVoice(voice.effectiveVoiceId, "live")}
      type="button"
    >
      {previewBusy === voice.effectiveVoiceId ? (
        <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
      ) : (
        <Play aria-hidden="true" className="h-4 w-4" />
      )}
      {active
        ? t("Preview unavailable")
        : previewBusy === voice.effectiveVoiceId ? t("Rendering…") : t("Preview")}
    </WorkspaceButton>
  );

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="character-voice-authority"
        className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5 sm:p-6"
        data-testid="voice-control-room"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--ad-text-muted)]" id="character-voice-authority">
              {t("Current voice")}
            </h3>
            <p className="mt-1 truncate text-2xl font-semibold tracking-[-0.01em] text-[var(--ad-ink)]">
              {liveVoiceName}
            </p>
            <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
              <MetaItem label={t("Model")} value={voiceProviderLabel(liveProvider)} />
              <MetaItem
                label={t("Current source")}
                value={voice.authoritySource === "character_clone" ? t("Character override") : t("System inheritance")}
              />
              {active ? (
                <MetaItem label={t("Version")} value={`v${active.version}`} />
              ) : null}
              {liveProvider === "fish_audio" ? (
                <MetaItem
                  label={t("Voice delivery")}
                  value={t(deliveryPresetLabel(active?.delivery.preset ?? voice.systemDefaults.delivery.preset))}
                />
              ) : null}
            </dl>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:shrink-0">
            {liveAudio}
            {voice.currentVoiceId !== null ? (
              <WorkspaceButton
                disabled={!canActivate || busy}
                onClick={() => setDialog({ kind: "reset", reviewKey: authorityReviewKey })}
                type="button"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4" />
                {busyAction === "reset" ? t("Restoring system default…") : t("Use system default voice")}
              </WorkspaceButton>
            ) : null}
          </div>
        </div>
        {error?.scope === "live" ? <InlineAlert tone="error">{t(error.text)}</InlineAlert> : null}
      </section>

      {message ? (
        <p
          className="rounded-lg bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]"
          role="status"
        >
          {t(message)}
        </p>
      ) : null}

      {candidate ? (
        <section
          aria-labelledby="voice-candidate-review-title"
          className="overflow-hidden rounded-xl border border-[var(--ad-blue-text)]/40 bg-[var(--ad-blue-bg)]"
          data-testid="voice-candidate-primary-action"
          id="voice-candidate-review"
        >
          <div className="flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="warn" value={t("candidate")} />
                <span className="text-xs text-[var(--ad-text-muted)]">
                  {voiceProviderLabel(candidate.provider)} · v{candidate.version}
                </span>
              </div>
              <h3 className="mt-2 text-lg font-semibold text-[var(--ad-ink)]" id="voice-candidate-review-title">
                {t("Listen to {voice} before activating it", { voice: profileName(candidate) })}
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text)]">
                {t("Creating a candidate keeps the current voice unchanged. Listen before activation; activation affects newly generated speech.")}
              </p>
              {candidate.provider === "fish_audio" ? (
                <VoiceDeliverySummary delivery={candidate.delivery} t={t} />
              ) : null}
              {candidate.reference.transcript ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text)]">
                    {t("Reference transcript")} · {candidate.reference.filename}
                  </summary>
                  <p className="mt-2 max-w-2xl text-sm leading-6">{candidate.reference.transcript}</p>
                </details>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 lg:w-80 lg:shrink-0">
              {candidate.preview ? (
                <audio
                  aria-label={t("Candidate voice preview")}
                  className="h-10 w-full"
                  controls
                  preload="metadata"
                  src={candidate.preview.url}
                />
              ) : (
                <p className="text-sm text-[var(--ad-text)]">{t("No preview is available for this candidate.")}</p>
              )}
              <WorkspaceButton
                disabled={!canActivate || !activationProviderAvailable || busy}
                onClick={() => void activateCandidate()}
                tone="primary"
                type="button"
              >
                <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                {busyAction === "activate" ? t("Activating voice…") : t("Activate voice")}
              </WorkspaceButton>
            </div>
          </div>
          {!canActivate && !busy ? (
            <p className="border-t border-[var(--ad-blue-text)]/20 px-5 py-3 text-xs text-[var(--ad-text)] sm:px-6">
              {t("Read-only: character.release.publish is required to activate a voice.")}
            </p>
          ) : null}
          {canActivate && !activationProviderAvailable ? (
            <p
              className="border-t border-[var(--ad-blue-text)]/20 bg-[var(--ad-yellow-bg)] px-5 py-3 text-xs text-[var(--ad-yellow-text)] sm:px-6"
              role="alert"
            >
              {t("The candidate provider must be ready before this voice can be activated.")}
            </p>
          ) : null}
          {actionError?.action === "activate" ? (
            <div className="px-5 pb-5 sm:px-6">
              <ActionErrorAlert copy={actionError.copy} t={t} />
            </div>
          ) : null}
        </section>
      ) : null}

      <section
        aria-labelledby="voice-change-title"
        className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
        data-testid="voice-change"
      >
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <h3 className="text-lg font-semibold text-[var(--ad-ink)]" id="voice-change-title">
            {t("Change voice")}
          </h3>
          <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
            {t("Pick a model, then a voice. Changes only affect speech generated afterwards.")}
          </p>
        </div>

        <fieldset className="px-5 pt-5 sm:px-6">
          <legend className="sr-only">{t("Model")}</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <ModelOption
              checked={model === "official"}
              description={t("{count} official English female voices. Listen instantly and apply in one step.", {
                count: catalogVoiceIds.length,
              })}
              detail={officialStatusDetail(officialStatus)}
              engine={voice.provider === "pocket_tts" ? engineLabel(voice) : null}
              icon={<ListMusic aria-hidden="true" className="h-5 w-5" />}
              id="voice-model-official"
              kind={t("Official voices")}
              name="Pocket TTS"
              onSelect={() => setModelChoice("official")}
              status={officialStatus}
              t={t}
            />
            <ModelOption
              checked={model === "clone"}
              description={t("Upload a reference recording to clone a dedicated voice, then listen before activating it.")}
              detail={cloneStatusDetail(voice.provider, cloneStatus)}
              engine={voice.provider === "fish_audio" ? engineLabel(voice) : null}
              icon={<Mic aria-hidden="true" className="h-5 w-5" />}
              id="voice-model-clone"
              kind={t("Voice cloning")}
              name={voice.provider === "mock" ? t("Voice cloning") : cloneProviderLabel}
              onSelect={() => setModelChoice("clone")}
              status={cloneStatus}
              t={t}
            />
          </div>
        </fieldset>

        {model === "official" ? (
          <div data-testid="voice-preset-builder">
            {/* A visible legend sits in the fieldset border, so padding lives on a wrapper. */}
            <div className="px-5 pt-6 sm:px-6">
            <fieldset>
              <legend className="text-sm font-semibold text-[var(--ad-ink)]">{t("Choose a voice")}</legend>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                {t("Press play to hear {character} with that voice.", { character: data.character.name })}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
                {catalogVoiceIds.map((voiceId) => (
                  <OfficialVoiceTile
                    busy={previewBusy === voiceId}
                    canPreview={canPreview && !busy && previewBusy === null && auditionText.length >= 3 && officialStatus === "ready"}
                    disabled={!canWrite || busy || officialStatus !== "ready"}
                    inUse={voiceId === livePresetVoiceId}
                    key={voiceId}
                    label={catalogLabel(voiceId)}
                    onAudition={() => auditionOfficialVoice(voiceId)}
                    onSelect={() => setPresetChoice(voiceId)}
                    selected={voiceId === selectedPresetVoiceId}
                    t={t}
                    voiceId={voiceId}
                  />
                ))}
              </div>
            </fieldset>
            </div>
            <details className="mx-5 mt-4 sm:mx-6">
              <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text-muted)]">
                {t("Customize preview script")}
              </summary>
              <textarea
                aria-label={t("Preview script")}
                className={`${textAreaClass} mt-2`}
                disabled={!canWrite || busy}
                id="character-pocket-preset-preview-script"
                maxLength={AUDITION_MAX_CHARS}
                onChange={(event) => setPresetSampleText(event.target.value)}
                value={presetSampleText}
              />
            </details>
            {officialStatus !== "ready" ? (
              <div className="px-5 sm:px-6">
                <InlineAlert tone="warn">{t(officialStatusDetail(officialStatus) ?? "")}</InlineAlert>
              </div>
            ) : null}
            {error?.scope === "audition" ? (
              <div className="px-5 sm:px-6">
                <InlineAlert tone="error">{t(error.text)}</InlineAlert>
              </div>
            ) : null}
            {actionError?.action === "preset" ? (
              <div className="px-5 sm:px-6">
                <ActionErrorAlert copy={actionError.copy} t={t} />
              </div>
            ) : null}
            <div className="mt-5 flex flex-col gap-4 border-t border-[var(--ad-border)] bg-[var(--ad-surface-subtle)]/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <p className="text-sm">
                  <span className="text-[var(--ad-text-muted)]">{t("Selected")} </span>
                  <strong className="font-semibold text-[var(--ad-ink)]">
                    {selectedPresetVoiceId ? catalogLabel(selectedPresetVoiceId) : "—"}
                  </strong>
                </p>
                {catalogPreview?.scope === "audition" &&
                catalogPreview.voiceId === selectedPresetVoiceId &&
                catalogPreview.signature === previewSignature(selectedPresetVoiceId, voice.systemDefaults.delivery, auditionText) ? (
                  <audio
                    aria-label={t("Preview {voice}", { voice: catalogLabel(selectedPresetVoiceId) })}
                    autoPlay
                    className="h-9 w-full sm:w-64"
                    controls
                    src={catalogPreview.src}
                  />
                ) : null}
              </div>
              <WorkspaceButton
                className="sm:shrink-0"
                disabled={!officialApplyReady || busy}
                onClick={() => void applyOfficialVoice(selectedPresetVoiceId, canActivate)}
                tone="primary"
                type="button"
              >
                {busyAction === "preset" ? (
                  <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
                ) : (
                  <Check aria-hidden="true" className="h-4 w-4" />
                )}
                {busyAction === "preset"
                  ? t("Applying voice…")
                  : selectedIsLiveOverride
                    ? t("Already in use")
                    : canActivate
                      ? t("Use as character voice")
                      : t("Submit as candidate")}
              </WorkspaceButton>
            </div>
            {!canWrite ? (
              <p className="border-t border-[var(--ad-border)] px-5 py-3 text-xs text-[var(--ad-text-muted)] sm:px-6">
                {t("Read-only: character write permission is required to change the voice.")}
              </p>
            ) : null}
          </div>
        ) : (
          <form id="voice-candidate-builder" onSubmit={submitClone}>
            {cloneStatus !== "ready" ? (
              <div className="px-5 sm:px-6">
                <InlineAlert tone="warn">{t(cloneStatusDetail(voice.provider, cloneStatus) ?? "")}</InlineAlert>
              </div>
            ) : null}
            <div className="grid gap-6 px-5 pt-6 sm:px-6 lg:grid-cols-2">
              <section aria-labelledby="voice-reference-identity" className="min-w-0 space-y-4">
                <h4 className="text-sm font-semibold text-[var(--ad-ink)]" id="voice-reference-identity">
                  {t("Reference identity")}
                </h4>
                <div className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  <span>{t("Voice reference audio")}</span>
                  <input
                    accept=".wav,.mp3,.flac,.ogg,audio/wav,audio/mpeg,audio/flac,audio/ogg"
                    aria-describedby="character-voice-reference-help"
                    className="sr-only"
                    disabled={!canWrite || cloneStatus !== "ready" || busy}
                    id="character-voice-reference"
                    name="audio"
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    ref={fileInput}
                    type="file"
                  />
                  <div className="mt-1 flex min-h-11 items-center rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-1">
                    <label
                      className={cn(
                        "inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded px-3 text-xs font-semibold text-[var(--ad-ink)] hover:bg-black/[0.04]",
                        (!canWrite || cloneStatus !== "ready" || busy) && "cursor-not-allowed opacity-50",
                      )}
                      htmlFor="character-voice-reference"
                    >
                      <Upload aria-hidden="true" className="h-3.5 w-3.5" />
                      {t("Choose audio")}
                    </label>
                    <span className="min-w-0 truncate px-3 font-normal text-[var(--ad-ink)]">
                      {file?.name ?? t("No audio selected")}
                    </span>
                  </div>
                  <span className="mt-1 block font-normal" id="character-voice-reference-help">
                    {t("WAV, MP3, FLAC, or OGG · maximum 15 MB")}
                  </span>
                </div>
                <label className="block text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Reference transcript")}
                  <textarea
                    className={`${textAreaClass} mt-1 min-h-32`}
                    disabled={!canWrite || cloneStatus !== "ready" || busy}
                    id="character-voice-reference-transcript"
                    maxLength={2_000}
                    name="referenceText"
                    onChange={(event) => setReferenceText(event.target.value)}
                    placeholder={t("Enter the exact words spoken in the reference recording.")}
                    value={referenceText}
                  />
                  <span className="mt-1 block font-normal">
                    {t(voiceReferenceTranscriptHelp(voice.provider))}
                  </span>
                </label>
              </section>
              <section aria-labelledby="voice-clone-preview" className="min-w-0 space-y-4">
                <h4 className="text-sm font-semibold text-[var(--ad-ink)]" id="voice-clone-preview">
                  {t("Preview script")}
                </h4>
                <label className="block text-xs font-semibold text-[var(--ad-text-muted)]">
                  <span className="sr-only">{t("Preview script")}</span>
                  <textarea
                    className={`${textAreaClass} min-h-32`}
                    disabled={!canWrite || busy}
                    id="character-voice-preview-script"
                    maxLength={500}
                    name="sampleText"
                    onChange={(event) => setSampleText(event.target.value)}
                    value={sampleText}
                  />
                </label>
              </section>
            </div>
            {voice.provider === "fish_audio" ? (
              <section
                aria-labelledby="character-performance-direction"
                className="mx-5 mt-6 border-t border-[var(--ad-border)] pt-5 sm:mx-6"
              >
                <h4 className="text-sm font-semibold text-[var(--ad-ink)]" id="character-performance-direction">
                  {t("Voice delivery")}
                </h4>
                <div className="mt-3">
                  <VoiceDeliveryEditor
                    delivery={cloneDelivery}
                    disabled={!canWrite || busy}
                    onChange={setCloneDelivery}
                    t={t}
                  />
                </div>
              </section>
            ) : null}
            {actionError?.action === "clone" ? (
              <div className="px-5 sm:px-6">
                <ActionErrorAlert copy={actionError.copy} t={t} />
              </div>
            ) : null}
            <div className="mt-6 flex flex-col gap-3 border-t border-[var(--ad-border)] bg-[var(--ad-surface-subtle)]/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="text-sm text-[var(--ad-text-muted)]">
                {t("{done} of {total} required inputs ready", {
                  done: cloneReadyCount,
                  total: cloneReadiness.length,
                })}
              </p>
              <WorkspaceButton
                disabled={!canWrite || cloneStatus !== "ready" || busy || cloneReadyCount !== cloneReadiness.length}
                tone="primary"
                type="submit"
              >
                {busyAction === "clone" ? (
                  <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
                ) : (
                  <Upload aria-hidden="true" className="h-4 w-4" />
                )}
                {busyAction === "clone" ? t("Cloning and rendering preview…") : t("Clone and render preview")}
              </WorkspaceButton>
            </div>
          </form>
        )}
      </section>

      {archivedProfiles.length > 0 ? (
        <details className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 sm:px-6">
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <History aria-hidden="true" className="h-4 w-4 text-[var(--ad-text-muted)]" />
              {t("Voice history")}
            </span>
            <StatusBadge value={`${archivedProfiles.length}`} />
          </summary>
          <ul className="divide-y divide-[var(--ad-border)] border-t border-[var(--ad-border)]">
            {archivedProfiles.map((profile) => (
              <li className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm sm:px-6" key={profile.id}>
                <span className="min-w-0">
                  <strong className="font-semibold">{profileName(profile)}</strong>
                  <span className="text-[var(--ad-text-muted)]">
                    {" "}· {voiceProviderLabel(profile.provider)} · v{profile.version} ·{" "}
                    {new Date(profile.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}
                  </span>
                </span>
                <StatusBadge value={profile.status} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <details
        className="group overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
        data-testid="system-voice-defaults"
      >
        <summary className="flex cursor-pointer list-none flex-col items-start justify-between gap-4 p-5 sm:flex-row sm:p-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--ad-surface-subtle)] text-[var(--ad-text)]">
              <Settings2 aria-hidden="true" className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold" id="system-voice-defaults-title">
                {t("System voice defaults")}
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
                {t("Controls every character without a voice override.")}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <StatusBadge
                  value={voice.systemDefaults.source === "app_setting" ? t("saved in Admin") : t("environment fallback")}
                />
                <StatusBadge value={`${t("version")} ${voice.systemDefaults.settingVersion}`} />
                <StatusBadge value={voiceProviderLabel(voice.systemDefaults.provider)} />
                {voice.authoritySource === "system_default" ? (
                  <StatusBadge tone="good" value={t("used here")} />
                ) : null}
              </div>
            </div>
          </div>
          <span className="shrink-0 self-start rounded-md border border-[var(--ad-border)] px-3 py-2 text-xs font-semibold text-[var(--ad-text-muted)]">
            <span className="group-open:hidden">{t("Open system defaults")}</span>
            <span className="hidden group-open:inline">{t("Close system defaults")}</span>
          </span>
        </summary>
        <div aria-labelledby="system-voice-defaults-title" className="border-t border-[var(--ad-border)] p-5 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
            <div className="space-y-3">
              <p className="text-xs leading-5 text-[var(--ad-text-muted)]">{t("Gender mappings select inherited voices. The fallback is used for other or unspecified genders.")}</p>
              <VoiceDefaultSelect
                active={false}
                busy={previewBusy}
                disabled={!canManageDefaults || busy || defaultDraftStale}
                canPreview={canPreview && !busy && !defaultDraftStale}
                catalog={defaultDraft.catalog}
                inputId="system-voice-default-global"
                label={t("System fallback identity")}
                onChange={(defaultVoiceId) => setDefaultDraftOverride({ ...defaultDraft, defaultVoiceId })}
                onPreview={previewCatalogVoice}
                t={t}
                value={defaultDraft.defaultVoiceId}
              />
              {(["female", "male", "trans"] as const).map((gender) => (
                <VoiceDefaultSelect
                  key={gender}
                  active={voice.authoritySource === "system_default" && data.character.gender === gender && defaultDraft.genderVoiceIds[gender] === voice.effectiveVoiceId && (voice.systemDefaults.provider !== "fish_audio" || JSON.stringify(defaultDraft.delivery) === JSON.stringify(voice.systemDefaults.delivery))}
                  busy={previewBusy}
                  disabled={!canManageDefaults || busy || defaultDraftStale}
                  canPreview={canPreview && !busy && !defaultDraftStale}
                  catalog={defaultDraft.catalog}
                  inputId={`system-voice-default-${gender}`}
                  label={t({ female: "Female character default", male: "Male character default", trans: "Trans character default" }[gender])}
                  onChange={(voiceId) => setDefaultDraftOverride({ ...defaultDraft, genderVoiceIds: { ...defaultDraft.genderVoiceIds, [gender]: voiceId } })}
                  onPreview={previewCatalogVoice}
                  t={t}
                  value={defaultDraft.genderVoiceIds[gender]}
                />
              ))}
            </div>
            <div className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-4">
              <div className="mb-4">
                <h4 className="text-sm font-semibold">{t("System performance direction")}</h4>
                {defaultDraft.provider === "fish_audio" ? (
                  <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t("Set the sensual character of every inherited voice. Identity and performance stay separate.")}</p>
                ) : null}
              </div>
              {defaultDraft.provider === "pocket_tts" ? (
                <p className="text-sm leading-6 text-[var(--ad-text-muted)]">
                  {t("Pocket TTS uses each official voice's native English delivery; performance controls are not applied.")}
                </p>
              ) : (
                <VoiceDeliveryEditor
                  disabled={!canManageDefaults || busy || defaultDraftStale}
                  delivery={defaultDraft.delivery}
                  onChange={(delivery) => setDefaultDraftOverride({ ...defaultDraft, delivery })}
                  t={t}
                />
              )}
            </div>
          </div>
          {catalogPreview?.scope === "draft" && catalogPreview.signature === previewSignature(catalogPreview.voiceId, defaultDraft.delivery, "draft") ? (
            <div className="mt-4 grid gap-3 rounded-lg bg-[var(--ad-blue-bg)] p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <p className="text-sm font-semibold text-[var(--ad-blue-text)]">
                  {t("Previewing {voice}", { voice: t(catalogLabel(catalogPreview.voiceId)) })}
                </p>
                <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                  {t("Listen before saving the default mapping.")}
                </p>
              </div>
              <audio aria-label={t("System voice preview")} autoPlay className="w-full sm:w-72" controls src={catalogPreview.src} />
            </div>
          ) : null}
          {error?.scope === "draft" ? <InlineAlert tone="error">{t(error.text)}</InlineAlert> : null}
          {defaultDraftStale ? (
            <div role="alert" className="mt-4 space-y-3 rounded-lg bg-[var(--ad-yellow-bg)] p-4 text-sm">
              <p>{t("System defaults changed while you were editing. Your draft is preserved; load the current defaults before editing again.")}</p>
              <WorkspaceButton disabled={busy} onClick={() => setDefaultDraftOverride(null)} type="button">
                {t("Discard draft and load current defaults")}
              </WorkspaceButton>
            </div>
          ) : null}
          <div className="mt-5 border-t border-[var(--ad-border)] pt-4">
            <WorkspaceButton
              disabled={!canManageDefaults || busy || defaultDraftStale}
              onClick={() => setDialog({ kind: "defaults", draft: defaultDraft, reviewKey: null })}
              tone="primary"
              type="button"
            >
              <Save aria-hidden="true" className="h-4 w-4" />
              {busyAction === "defaults" ? t("Saving defaults…") : t("Save system defaults")}
            </WorkspaceButton>
          </div>
          {!canManageDefaults && !busy ? (
            <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
              {t("Read-only: generation.config.write is required to change system voice defaults.")}
            </p>
          ) : null}
        </div>
      </details>

      {dialogSpec ? <ConfirmDialog onClose={() => setDialog(null)} spec={dialogSpec} /> : null}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="inline text-[var(--ad-text-muted)]">{label} </dt>
      <dd className="inline font-semibold text-[var(--ad-ink)]">{value}</dd>
    </div>
  );
}

function InlineAlert({ children, tone }: { children: ReactNode; tone: "warn" | "error" }) {
  return (
    <p
      className={cn(
        "mt-4 rounded-lg px-4 py-3 text-sm",
        tone === "error"
          ? "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]"
          : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
      )}
      role="alert"
    >
      {children}
    </p>
  );
}

function ActionErrorAlert({ copy, t }: { copy: OperatorErrorCopy; t: Translate }) {
  return (
    <div className="mt-4 rounded-lg bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">
      <span className="block font-semibold">{t(copy.headline)}</span>
      <span className="mt-1 block">{t(copy.nextStep, copy.nextStepValues)}</span>
      <RequestErrorDetails technical={copy.technical} />
    </div>
  );
}

function ModelOption({
  checked,
  description,
  detail,
  engine,
  icon,
  id,
  kind,
  name,
  onSelect,
  status,
  t,
}: {
  checked: boolean;
  description: string;
  detail: string | null;
  engine: string | null;
  icon: ReactNode;
  id: string;
  kind: string;
  name: string;
  onSelect: () => void;
  status: ModelStatus;
  t: Translate;
}) {
  const disabled = status === "inactive";
  return (
    <label
      className={cn(
        "relative flex cursor-pointer gap-3 rounded-lg border p-4 transition-[border-color,box-shadow] duration-150 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[var(--ad-ink)]",
        checked
          ? "border-[var(--ad-ink)] shadow-[inset_0_0_0_1px_var(--ad-ink)]"
          : "border-[var(--ad-border)] hover:border-[#bdbbb3]",
        disabled && "cursor-not-allowed opacity-60 hover:border-[var(--ad-border)]",
      )}
      htmlFor={id}
    >
      <input
        checked={checked}
        className="sr-only"
        disabled={disabled}
        id={id}
        name="character-voice-model"
        onChange={onSelect}
        type="radio"
      />
      <span
        className={cn(
          "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
          checked ? "bg-[var(--ad-ink)] text-white" : "bg-[var(--ad-surface-subtle)] text-[var(--ad-text)]",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-[var(--ad-ink)]">
            {name}
            <span className="font-normal text-[var(--ad-text-muted)]"> · {kind}</span>
          </span>
          <ModelStatusLabel status={status} t={t} />
        </span>
        <span className="mt-1 block text-xs leading-5 text-[var(--ad-text-muted)]">{description}</span>
        {engine ? (
          <span className="mt-1 block text-xs text-[var(--ad-text-muted)]">
            {t("Engine")} {engine}
          </span>
        ) : null}
        {disabled && detail ? (
          <span className="mt-2 block text-xs leading-5 text-[var(--ad-yellow-text)]">{t(detail)}</span>
        ) : null}
      </span>
    </label>
  );
}

function ModelStatusLabel({ status, t }: { status: ModelStatus; t: Translate }) {
  const ready = status === "ready";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold",
        ready ? "text-[var(--ad-green-text)]" : "text-[var(--ad-yellow-text)]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-2 w-2 rounded-full", ready ? "bg-[var(--ad-green-text)]" : "bg-[var(--ad-yellow-text)]")}
      />
      {t({
        ready: "runtime ready",
        unavailable: "voice service unavailable",
        inactive: "voice provider inactive",
        cloning_disabled: "cloning not enabled",
      }[status])}
    </span>
  );
}

function OfficialVoiceTile({
  busy,
  canPreview,
  disabled,
  inUse,
  label,
  onAudition,
  onSelect,
  selected,
  t,
  voiceId,
}: {
  busy: boolean;
  canPreview: boolean;
  disabled: boolean;
  inUse: boolean;
  label: string;
  onAudition: () => void;
  onSelect: () => void;
  selected: boolean;
  t: Translate;
  voiceId: string;
}) {
  const inputId = `character-official-voice-${voiceId}`;
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg border bg-[var(--ad-surface)] pl-3 pr-1 transition-[border-color,box-shadow] duration-150 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-[var(--ad-ink)]",
        selected
          ? "border-[var(--ad-ink)] shadow-[inset_0_0_0_1px_var(--ad-ink)]"
          : "border-[var(--ad-border)] hover:border-[#bdbbb3]",
      )}
      data-voice-id={voiceId}
    >
      <label
        className={cn("flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-2", disabled && "cursor-not-allowed")}
        htmlFor={inputId}
      >
        <input
          checked={selected}
          className="sr-only"
          disabled={disabled}
          id={inputId}
          name="character-official-voice"
          onChange={onSelect}
          type="radio"
          value={voiceId}
        />
        <span
          aria-hidden="true"
          className={cn(
            "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
            selected ? "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white" : "border-[#b9b7af]",
          )}
        >
          {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-[var(--ad-ink)]">{label}</span>
          {inUse ? (
            <span className="block text-[11px] font-semibold leading-4 text-[var(--ad-green-text)]">{t("In use")}</span>
          ) : null}
        </span>
      </label>
      <button
        aria-label={t("Preview {voice}", { voice: label })}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[var(--ad-text)] transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!canPreview}
        onClick={onAudition}
        type="button"
      >
        {busy ? (
          <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
        ) : (
          <Play aria-hidden="true" className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

function officialStatusDetail(status: ModelStatus) {
  return {
    ready: null,
    unavailable: "Official voice service is unavailable. Refresh after it recovers.",
    inactive: "Official voices require Pocket TTS as the system voice provider.",
    cloning_disabled: null,
  }[status];
}

function cloneStatusDetail(provider: VoiceData["provider"], status: ModelStatus) {
  if (status === "ready") return null;
  if (status === "cloning_disabled") return "Voice cloning is not enabled on this model.";
  return voiceRuntimeMessage(provider, status);
}

function engineLabel(voice: VoiceData) {
  const version = voice.runtimeVersion ?? "";
  if (voice.runtimeEngine === "mlx_audio") return `MLX ${version}`.trim();
  if (voice.runtimeEngine === "pocket_tts") return `Pocket TTS ${version}`.trim();
  return null;
}

function voiceIdForGender(
  defaults: VoiceData["systemDefaults"],
  gender: CharacterWorkspaceDetail["character"]["gender"],
) {
  return gender === "female" || gender === "male" || gender === "trans"
    ? defaults.genderVoiceIds[gender]
    : defaults.defaultVoiceId;
}

function VoiceDeliveryEditor({
  delivery,
  disabled,
  onChange,
  t,
}: {
  delivery: FishAudioDeliverySettings;
  disabled: boolean;
  onChange: (value: FishAudioDeliverySettings) => void;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const presets = [
    { id: "sensual", label: "Sensual", description: "Low, breathy, magnetic" },
    {
      id: "intimate",
      label: "Intimate",
      description: "Soft, private, close-mic",
    },
    { id: "playful", label: "Playful", description: "Teasing, bright, lively" },
    {
      id: "confident",
      label: "Confident",
      description: "Assured, poised, commanding",
    },
    { id: "natural", label: "Natural", description: "Warm and conversational" },
  ] as const;

  return (
    <div className="space-y-5">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {presets.map((preset) => {
          const selected = delivery.preset === preset.id;
          return (
            <button
              className={`min-h-20 rounded-lg border px-3 py-2 text-left transition ${
                selected
                  ? "border-[var(--ad-blue-text)] bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
                  : "border-[var(--ad-border)] bg-[var(--ad-surface)] hover:border-[var(--ad-blue-text)]"
              }`}
              disabled={disabled}
              key={preset.id}
              onClick={() => onChange({ ...delivery, preset: preset.id })}
              type="button"
            >
              <span className="block text-sm font-semibold">
                {t(preset.label)}
              </span>
              <span className="mt-1 block text-xs leading-4 text-[var(--ad-text-muted)]">
                {t(preset.description)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
          <span className="flex items-center justify-between gap-3">
            {t("Attraction intensity")}
            <strong className="text-[var(--ad-text)]">
              {delivery.intensity}%
            </strong>
          </span>
          <input
            className="mt-2 w-full accent-[var(--ad-blue-text)]"
            disabled={disabled}
            max={100}
            min={0}
            onChange={(event) =>
              onChange({ ...delivery, intensity: Number(event.target.value) })
            }
            step={1}
            type="range"
            value={delivery.intensity}
          />
        </label>
        <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
          <span className="flex items-center justify-between gap-3">
            {t("Speaking pace")}
            <strong className="text-[var(--ad-text)]">
              {delivery.speed.toFixed(2)}×
            </strong>
          </span>
          <input
            className="mt-2 w-full accent-[var(--ad-blue-text)]"
            disabled={disabled}
            max={1.3}
            min={0.7}
            onChange={(event) =>
              onChange({ ...delivery, speed: Number(event.target.value) })
            }
            step={0.01}
            type="range"
            value={delivery.speed}
          />
        </label>
      </div>
      <details className="border-t border-[var(--ad-border)] pt-3">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text-muted)]">
          {t("Advanced Fish sampling")}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <DeliveryNumberField
            disabled={disabled}
            label={t("Temperature")}
            max={1.5}
            min={0.1}
            onChange={(temperature) => onChange({ ...delivery, temperature })}
            step={0.01}
            value={delivery.temperature}
          />
          <DeliveryNumberField
            disabled={disabled}
            label={t("Top P")}
            max={1}
            min={0.1}
            onChange={(topP) => onChange({ ...delivery, topP })}
            step={0.01}
            value={delivery.topP}
          />
          <DeliveryNumberField
            disabled={disabled}
            label={t("Top K")}
            max={100}
            min={1}
            onChange={(topK) => onChange({ ...delivery, topK })}
            step={1}
            value={delivery.topK}
          />
          <DeliveryNumberField
            disabled={disabled}
            label={t("Repetition penalty")}
            max={2}
            min={1}
            onChange={(repetitionPenalty) =>
              onChange({ ...delivery, repetitionPenalty })
            }
            step={0.01}
            value={delivery.repetitionPenalty}
          />
        </div>
      </details>
    </div>
  );
}

function DeliveryNumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  return (
    <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        className={`${fieldClass} mt-1`}
        disabled={disabled}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

function VoiceDeliverySummary({
  delivery,
  t,
}: {
  delivery: FishAudioDeliverySettings;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      <span className="rounded-full bg-[var(--ad-blue-bg)] px-2.5 py-1 font-semibold text-[var(--ad-blue-text)]">
        {t(deliveryPresetLabel(delivery.preset))}
      </span>
      <span className="rounded-full bg-[var(--ad-surface)] px-2.5 py-1 text-[var(--ad-text-muted)]">
        {t("{value}% intensity", { value: delivery.intensity })}
      </span>
      <span className="rounded-full bg-[var(--ad-surface)] px-2.5 py-1 text-[var(--ad-text-muted)]">
        {delivery.speed.toFixed(2)}×
      </span>
    </div>
  );
}

function VoiceDefaultSelect({
  active,
  busy,
  canPreview,
  disabled,
  catalog,
  inputId,
  label,
  onChange,
  onPreview,
  t,
  value,
}: {
  active: boolean;
  busy: SystemVoiceCatalogVoiceId | null;
  canPreview: boolean;
  disabled: boolean;
  catalog: CharacterWorkspaceDetail["voice"]["systemDefaults"]["catalog"];
  inputId: string;
  label: string;
  onChange: (value: SystemVoiceCatalogVoiceId) => void;
  onPreview: (value: SystemVoiceCatalogVoiceId) => Promise<void>;
  t: (key: string, values?: Record<string, string | number>) => string;
  value: SystemVoiceCatalogVoiceId;
}) {
  const selected = catalog.find((voice) => voice.id === value);
  return (
    <article
      className={`rounded-lg border p-3 transition-colors ${
        active
          ? "border-[var(--ad-blue-text)] bg-[var(--ad-blue-bg)]"
          : "border-[var(--ad-border)] bg-[var(--ad-surface)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <label
          className="text-xs font-semibold text-[var(--ad-text-muted)]"
          htmlFor={inputId}
        >
          {label}
        </label>
        {active ? <StatusBadge tone="good" value={t("used here")} /> : null}
      </div>
      <select
        className={`${fieldClass} mt-2`}
        id={inputId}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value as SystemVoiceCatalogVoiceId)
        }
        value={value}
      >
        {catalog.map((voice) => (
          <option key={voice.id} value={voice.id}>
            {t(voice.label)}
          </option>
        ))}
      </select>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--ad-text-muted)]">
          {selected ? t(selected.description) : "N/A"}
        </span>
        <WorkspaceButton
          aria-label={t("Preview {voice}", {
            voice: selected?.label ?? value,
          })}
          disabled={!canPreview || busy !== null}
          onClick={() => void onPreview(value)}
          type="button"
        >
          {busy === value ? (
            <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
          ) : (
            <Play aria-hidden="true" className="h-4 w-4" />
          )}
          {busy === value ? t("Rendering…") : t("Preview")}
        </WorkspaceButton>
      </div>
    </article>
  );
}

function formatCatalogVoiceName(voiceId: string) {
  const words = voiceId.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function deliveryPresetLabel(preset: FishAudioDeliverySettings["preset"]) {
  return {
    sensual: "Sensual",
    intimate: "Intimate",
    playful: "Playful",
    confident: "Confident",
    natural: "Natural",
  }[preset];
}

function voiceRuntimeMessage(
  provider: CharacterWorkspaceDetail["voice"]["provider"],
  status: CharacterWorkspaceDetail["voice"]["runtimeStatus"],
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
    ready: "Fish Audio S2 Pro voice cloning through MLX is ready.",
    unavailable:
      "Fish Audio is configured but unavailable. Verify the fish-audio-s2-pro-8bit model, resident MLX process, and system female reference.",
    inactive:
      "Fish Audio is not the Character voice-cloning provider. Set VOICE_IDENTITY_PROVIDER=fish-audio and start the Fish Audio process.",
  }[status];
}

function voiceProviderLabel(
  provider: CharacterWorkspaceDetail["voice"]["provider"],
) {
  if (provider === "pocket_tts") return "Pocket TTS";
  if (provider === "fish_audio") return "Fish Audio S2 Pro";
  return provider;
}

function voiceReferenceTranscriptHelp(
  provider: CharacterWorkspaceDetail["voice"]["provider"],
) {
  return provider === "pocket_tts"
    ? "This transcript is stored with the Pocket TTS reference voice for audit and reproducibility."
    : "This transcript is stored with the voice reference and used by Fish Audio when synthesizing.";
}
