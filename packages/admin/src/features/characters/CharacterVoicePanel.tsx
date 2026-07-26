"use client";

import {
  characterVoiceActivationResponseSchema,
  characterVoiceCloneCreateResponseSchema,
  characterVoiceSystemDefaultResetResponseSchema,
  DEFAULT_FISH_AUDIO_DELIVERY,
  voiceDefaultPreviewResponseSchema,
  voiceDefaultSettingsUpdateResponseSchema,
  type FishAudioCatalogVoiceId,
  type FishAudioDeliverySettings,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import {
  Activity,
  AudioLines,
  ArrowRight,
  CheckCircle2,
  FileAudio,
  Gauge,
  History,
  Mic2,
  Play,
  Radio,
  RotateCcw,
  Save,
  Settings2,
  Upload,
} from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import {
  StatusBadge,
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { adminV2FormRequest, adminV2Request } from "@/lib/admin-v2-api";

type RunCommittedMutation = <T>(input: {
  readonly action: string;
  readonly commit: () => Promise<T>;
  readonly afterRefresh?: () => void;
}) => Promise<{ readonly result: T; readonly refreshed: boolean }>;

export function CharacterVoicePanel({
  data,
  canWrite,
  canActivate,
  canManageDefaults,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  canActivate: boolean;
  canManageDefaults: boolean;
  runCommittedMutation: RunCommittedMutation;
}) {
  const { t, locale } = useAdminI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [sampleText, setSampleText] = useState(
    locale === "zh"
      ? `靠近一点，我是${data.character.name}。很高兴让你听见我的声音。`
      : `Come a little closer. I’m ${data.character.name}. It’s good to hear from you.`,
  );
  const [cloneDelivery, setCloneDelivery] = useState<FishAudioDeliverySettings>(
    {
      ...DEFAULT_FISH_AUDIO_DELIVERY,
    },
  );
  const [reason, setReason] = useState("");
  const [activationReason, setActivationReason] = useState("");
  const [resetReason, setResetReason] = useState("");
  const [defaultReason, setDefaultReason] = useState("");
  const [defaultDraftOverride, setDefaultDraftOverride] = useState<{
    settingVersion: number;
    defaultVoiceId: FishAudioCatalogVoiceId;
    genderVoiceIds: {
      female: FishAudioCatalogVoiceId;
      male: FishAudioCatalogVoiceId;
      trans: FishAudioCatalogVoiceId;
    };
    delivery: FishAudioDeliverySettings;
  } | null>(null);
  const defaultDraft =
    defaultDraftOverride?.settingVersion ===
    data.voice.systemDefaults.settingVersion
      ? defaultDraftOverride
      : {
          settingVersion: data.voice.systemDefaults.settingVersion,
          defaultVoiceId: data.voice.systemDefaults.defaultVoiceId,
          genderVoiceIds: { ...data.voice.systemDefaults.genderVoiceIds },
          delivery: { ...data.voice.systemDefaults.delivery },
        };
  const [previewBusy, setPreviewBusy] =
    useState<FishAudioCatalogVoiceId | null>(null);
  const [catalogPreview, setCatalogPreview] = useState<{
    voiceId: FishAudioCatalogVoiceId;
    src: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = data.voice.activeProfile;
  const candidate = data.voice.candidateProfile;
  const archivedProfiles = data.voice.history.filter(
    (profile) => profile.id !== active?.id && profile.id !== candidate?.id,
  );
  const candidateReadiness = [
    { complete: file !== null, label: "Voice reference audio" },
    {
      complete: referenceText.trim().length >= 3,
      label: "Reference transcript",
    },
    {
      complete: sampleText.trim().length >= 3,
      label: "Preview script",
    },
    { complete: reason.trim().length >= 3, label: "Change reason" },
  ];
  const candidateReadyCount = candidateReadiness.filter(
    (item) => item.complete,
  ).length;
  const activationProviderAvailable =
    data.voice.provider === "fish_audio" &&
    data.voice.runtimeStatus === "ready";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const form = new FormData();
    form.set("audio", file, file.name);
    form.set("language", data.voice.runtimeLanguage);
    form.set("referenceText", referenceText.trim());
    form.set("sampleText", sampleText.trim());
    form.set("delivery", JSON.stringify(cloneDelivery));
    form.set("reason", reason.trim());
    try {
      const mutation = await runCommittedMutation({
        action: "Fish Audio voice clone",
        commit: () =>
          adminV2FormRequest(
            `/api/v2/admin/characters/${encodeURIComponent(data.character.id)}/voice-clones`,
            {
              form,
              idempotencyKey: crypto.randomUUID(),
              schema: characterVoiceCloneCreateResponseSchema,
            },
          ),
        afterRefresh: () => {
          setFile(null);
          setReferenceText("");
          setReason("");
          if (fileInput.current) fileInput.current.value = "";
        },
      });
      setMessage(
        mutation.result.replayed
          ? "The existing voice candidate result was recovered."
          : "The voice candidate is ready. Review its preview before activation.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Voice cloning failed");
    } finally {
      setBusy(false);
    }
  }

  async function activateCandidate() {
    if (!candidate || busy || activationReason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const mutation = await runCommittedMutation({
        action: "Activate Fish Audio voice",
        commit: () =>
          adminV2Request(
            `/api/v2/admin/characters/${encodeURIComponent(data.character.id)}/voice-clones/${encodeURIComponent(candidate.id)}/activate`,
            {
              method: "POST",
              idempotencyKey: crypto.randomUUID(),
              body: {
                reason: activationReason.trim(),
                expectedActiveProfileId: active?.id ?? null,
                expectedCurrentVoiceId: data.voice.currentVoiceId,
              },
              schema: characterVoiceActivationResponseSchema,
            },
          ),
        afterRefresh: () => setActivationReason(""),
      });
      setMessage(
        mutation.result.replayed
          ? "The existing voice activation result was recovered."
          : "The reviewed voice is now active for new chat speech.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Voice activation failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveSystemDefaults() {
    if (!canManageDefaults || busy || defaultReason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const mutation = await runCommittedMutation({
        action: "Update system voice defaults",
        commit: () =>
          adminV2Request("/api/v2/admin/voice-defaults", {
            method: "PUT",
            idempotencyKey: crypto.randomUUID(),
            body: {
              expectedVersion: data.voice.systemDefaults.settingVersion,
              defaultVoiceId: defaultDraft.defaultVoiceId,
              genderVoiceIds: defaultDraft.genderVoiceIds,
              delivery: defaultDraft.delivery,
              reason: defaultReason.trim(),
            },
            schema: voiceDefaultSettingsUpdateResponseSchema,
          }),
        afterRefresh: () => {
          setDefaultReason("");
          setDefaultDraftOverride(null);
        },
      });
      setMessage(
        mutation.result.replayed
          ? "The saved system voice defaults were recovered."
          : "System voice defaults were saved. New speech now uses this mapping.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "System voice defaults could not be saved",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resetToSystemDefault() {
    if (
      !canActivate ||
      busy ||
      data.voice.currentVoiceId === null ||
      resetReason.trim().length < 3
    )
      return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const mutation = await runCommittedMutation({
        action: "Reset character voice to system default",
        commit: () =>
          adminV2Request(
            `/api/v2/admin/characters/${encodeURIComponent(data.character.id)}/voice-defaults/reset`,
            {
              method: "POST",
              idempotencyKey: crypto.randomUUID(),
              body: {
                reason: resetReason.trim(),
                expectedActiveProfileId: active?.id ?? null,
                expectedCurrentVoiceId: data.voice.currentVoiceId,
              },
              schema: characterVoiceSystemDefaultResetResponseSchema,
            },
          ),
        afterRefresh: () => setResetReason(""),
      });
      setMessage(
        mutation.result.replayed
          ? "The existing reset to system default was recovered."
          : "This character now inherits the system voice default.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The character voice could not be reset",
      );
    } finally {
      setBusy(false);
    }
  }

  async function previewCatalogVoice(voiceId: FishAudioCatalogVoiceId) {
    if (previewBusy || busy) return;
    setPreviewBusy(voiceId);
    setError(null);
    try {
      const preview = await adminV2Request(
        "/api/v2/admin/voice-defaults/preview",
        {
          method: "POST",
          body: {
            voiceId,
            text:
              locale === "zh"
                ? `靠近一点，我是${data.character.name}。这是系统女性声音的试听。`
                : `Come a little closer. I’m ${data.character.name}. This is the system female voice preview.`,
            delivery: defaultDraft.delivery,
          },
          schema: voiceDefaultPreviewResponseSchema,
        },
      );
      setCatalogPreview({
        voiceId,
        src: `data:${preview.contentType};base64,${preview.audioBase64}`,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The system voice preview could not be rendered",
      );
    } finally {
      setPreviewBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <section
        aria-labelledby="character-voice-authority"
        className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
        data-testid="voice-control-room"
      >
        <div className="grid gap-px bg-[var(--ad-border)] lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="bg-[var(--ad-surface)] p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]">
                <Radio aria-hidden="true" className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-blue-text)]">
                  {t("Voice control room")}
                </p>
                <h3
                  className="mt-1 text-xl font-semibold tracking-tight"
                  id="character-voice-authority"
                >
                  {data.character.name}
                </h3>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
                  {t(
                    "Shape the live character voice, review candidates, and control inherited defaults from one place.",
                  )}
                </p>
              </div>
            </div>
            <dl className="mt-6 grid gap-px overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-border)] sm:grid-cols-3">
              <div className="bg-[var(--ad-surface-subtle)] p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
                  {t("Current source")}
                </dt>
                <dd className="mt-1 text-sm font-semibold">
                  {data.voice.authoritySource === "character_clone"
                    ? t("Character override")
                    : t("System inheritance")}
                </dd>
              </div>
              <div className="bg-[var(--ad-surface-subtle)] p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
                  {t("Live voice")}
                </dt>
                <dd className="mt-1 truncate text-sm font-semibold">
                  {active
                    ? t("Voice version {version}", { version: active.version })
                    : t(voiceLabel(data, data.voice.effectiveVoiceId))}
                </dd>
              </div>
              <div className="bg-[var(--ad-surface-subtle)] p-3">
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
                  {t("Performance")}
                </dt>
                <dd className="mt-1 text-sm font-semibold">
                  {t(
                    deliveryPresetLabel(
                      active?.delivery.preset ??
                        data.voice.systemDefaults.delivery.preset,
                    ),
                  )}
                </dd>
              </div>
            </dl>
          </div>
          <aside className="flex flex-col justify-between bg-[var(--ad-ink)] p-5 text-white sm:p-6">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-white/60">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-full ${
                    candidate ? "bg-[#f4c46b]" : "bg-[#8fd09a]"
                  }`}
                />
                {t("Next action")}
              </div>
              <h4 className="mt-4 text-lg font-semibold">
                {candidate
                  ? t("Candidate awaiting review")
                  : t("Build a voice candidate")}
              </h4>
              <p className="mt-2 text-sm leading-6 text-white/70">
                {candidate
                  ? t(
                      "Listen and activate voice version {version} when it matches the character.",
                      {
                        version: candidate.version,
                      },
                    )
                  : t(
                      "Create a reviewed candidate without changing the live voice.",
                    )}
              </p>
            </div>
            <a
              className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-[var(--ad-ink)] transition hover:bg-white/90"
              href={
                candidate
                  ? "#voice-candidate-review"
                  : "#voice-candidate-builder"
              }
            >
              {candidate ? t("Review candidate") : t("Build candidate")}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </a>
          </aside>
        </div>
      </section>

      {error ? (
        <p
          className="rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {t(error)}
        </p>
      ) : null}
      {message ? (
        <p
          className="rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          role="status"
        >
          {t(message)}
        </p>
      ) : null}

      {candidate ? (
        <section
          aria-labelledby="voice-candidate-review-title"
          className="overflow-hidden rounded-xl border border-[var(--ad-blue-border)] bg-[var(--ad-surface)]"
          data-testid="voice-candidate-primary-action"
          id="voice-candidate-review"
        >
          <div className="grid gap-px bg-[var(--ad-blue-border)] lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="bg-[var(--ad-surface)] p-5 sm:p-6">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="warn" value={t("candidate")} />
                <span className="text-xs text-[var(--ad-text-muted)]">
                  {candidate.reference.filename} ·{" "}
                  {formatBytes(candidate.reference.sizeBytes, locale)}
                </span>
              </div>
              <h3
                className="mt-3 text-lg font-semibold"
                id="voice-candidate-review-title"
              >
                {t("Review voice version {version}", {
                  version: candidate.version,
                })}
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
                {t(
                  "Listen to the preview before changing the live character voice. Creating a candidate never changes Character.voiceId.",
                )}
              </p>
              <VoiceDeliverySummary delivery={candidate.delivery} t={t} />
              {candidate.reference.transcript ? (
                <details className="mt-4 rounded-lg bg-[var(--ad-surface-subtle)] px-3 py-2">
                  <summary className="cursor-pointer text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t("Reference transcript")}
                  </summary>
                  <p className="mt-2 text-sm leading-6">
                    {candidate.reference.transcript}
                  </p>
                </details>
              ) : null}
            </div>
            <div className="bg-[var(--ad-blue-bg)] p-5 sm:p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-blue-text)]">
                {t("Candidate preview")}
              </p>
              {candidate.preview ? (
                <audio
                  aria-label={t("Candidate voice preview")}
                  className="mt-3 w-full"
                  controls
                  preload="metadata"
                  src={candidate.preview.url}
                />
              ) : (
                <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
                  {t("No preview is available for this candidate.")}
                </p>
              )}
              <div className="mt-5 border-t border-[var(--ad-blue-border)] pt-4">
                <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Activation reason")}
                  <input
                    className={`${fieldClass} mt-1`}
                    disabled={
                      !canActivate || !activationProviderAvailable || busy
                    }
                    id="character-voice-activation-reason"
                    minLength={3}
                    name="activationReason"
                    onChange={(event) =>
                      setActivationReason(event.target.value)
                    }
                    value={activationReason}
                  />
                </label>
                <WorkspaceButton
                  className="mt-3 w-full"
                  disabled={
                    !canActivate ||
                    !activationProviderAvailable ||
                    busy ||
                    activationReason.trim().length < 3
                  }
                  onClick={() => void activateCandidate()}
                  tone="primary"
                  type="button"
                >
                  <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                  {busy
                    ? t("Activating reviewed voice…")
                    : t("Activate reviewed voice")}
                </WorkspaceButton>
              </div>
            </div>
          </div>
          {!canActivate ? (
            <p className="border-t border-[var(--ad-border)] px-5 py-3 text-xs text-[var(--ad-text-muted)]">
              {t(
                "Read-only: character.release.publish is required to activate a voice.",
              )}
            </p>
          ) : null}
          {canActivate && !activationProviderAvailable ? (
            <p
              className="border-t border-[var(--ad-border)] bg-[var(--ad-yellow-bg)] px-5 py-3 text-xs text-[var(--ad-yellow-text)]"
              role="alert"
            >
              {t(
                "Fish Audio must be the active voice provider before this candidate can be activated.",
              )}
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
        <form
          className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
          id="voice-candidate-builder"
          onSubmit={(event) => void submit(event)}
        >
          <div className="border-b border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] px-5 py-4 sm:px-6">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]">
                <Mic2 aria-hidden="true" className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold">
                  {candidate
                    ? t("Replace voice candidate")
                    : t("Create voice candidate")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-[var(--ad-text-muted)]">
                  {t(
                    "Use a clean adult female single-speaker recording. Fish Audio uses up to the first 30 seconds.",
                  )}
                </p>
              </div>
            </div>
          </div>
          {!data.voice.cloningAvailable ? (
            <p
              className="m-5 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)] sm:mx-6"
              role="alert"
            >
              {t(voiceRuntimeMessage(data.voice.runtimeStatus))}
            </p>
          ) : null}
          <div className="grid gap-px bg-[var(--ad-border)] lg:grid-cols-2">
            <section
              aria-labelledby="voice-reference-identity"
              className="bg-[var(--ad-surface)] p-5 sm:p-6"
            >
              <div className="flex items-center gap-2">
                <FileAudio
                  aria-hidden="true"
                  className="h-4 w-4 text-[var(--ad-blue-text)]"
                />
                <h4
                  className="text-sm font-semibold"
                  id="voice-reference-identity"
                >
                  {t("Reference identity")}
                </h4>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
                {t(
                  "Upload the recording that defines the voice identity, then enter its exact transcript.",
                )}
              </p>
              <div className="mt-4 grid gap-4">
                <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Voice reference audio")}
                  <input
                    accept=".wav,.mp3,.flac,.ogg,audio/wav,audio/mpeg,audio/flac,audio/ogg"
                    className={`${fieldClass} mt-1 file:mr-3 file:rounded file:border-0 file:bg-[var(--ad-surface-subtle)] file:px-3 file:py-2 file:text-xs file:font-semibold`}
                    disabled={!canWrite || !data.voice.cloningAvailable || busy}
                    id="character-voice-reference"
                    name="audio"
                    onChange={(event) =>
                      setFile(event.target.files?.[0] ?? null)
                    }
                    ref={fileInput}
                    required
                    type="file"
                  />
                  <span className="mt-1 block font-normal">
                    {t("WAV, MP3, FLAC, or OGG · maximum 15 MB")}
                  </span>
                </label>
                <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Reference transcript")}
                  <textarea
                    className={`${textAreaClass} mt-1 min-h-36`}
                    disabled={!canWrite || !data.voice.cloningAvailable || busy}
                    id="character-voice-reference-transcript"
                    maxLength={2_000}
                    minLength={3}
                    name="referenceText"
                    onChange={(event) => setReferenceText(event.target.value)}
                    placeholder={t(
                      "Enter the exact words spoken in the reference recording.",
                    )}
                    required
                    value={referenceText}
                  />
                  <span className="mt-1 block font-normal">
                    {t(
                      "This transcript is stored with the voice reference and used by Fish Audio when synthesizing.",
                    )}
                  </span>
                </label>
              </div>
            </section>

            <section
              aria-labelledby="voice-preview-audit"
              className="bg-[var(--ad-surface)] p-5 sm:p-6"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2
                  aria-hidden="true"
                  className="h-4 w-4 text-[var(--ad-blue-text)]"
                />
                <h4 className="text-sm font-semibold" id="voice-preview-audit">
                  {t("Preview and audit")}
                </h4>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
                {t(
                  "Write the line operators will hear, and record why this candidate was created.",
                )}
              </p>
              <div className="mt-4 grid gap-4">
                <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Preview script")}
                  <textarea
                    className={`${textAreaClass} mt-1 min-h-36`}
                    disabled={!canWrite || busy}
                    id="character-voice-preview-script"
                    maxLength={500}
                    minLength={3}
                    name="sampleText"
                    onChange={(event) => setSampleText(event.target.value)}
                    required
                    value={sampleText}
                  />
                </label>
                <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Change reason")}
                  <input
                    className={`${fieldClass} mt-1`}
                    disabled={!canWrite || busy}
                    id="character-voice-change-reason"
                    minLength={3}
                    name="reason"
                    onChange={(event) => setReason(event.target.value)}
                    required
                    value={reason}
                  />
                  <span className="mt-1 block font-normal">
                    {t("This reason is stored in the operator audit trail.")}
                  </span>
                </label>
              </div>
            </section>
          </div>

          <section
            aria-labelledby="character-performance-direction"
            className="border-t border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-5 sm:p-6"
          >
            <div className="mb-5 flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--ad-surface)] text-[var(--ad-blue-text)]">
                <Gauge aria-hidden="true" className="h-4 w-4" />
              </div>
              <div>
                <h4
                  className="text-sm font-semibold"
                  id="character-performance-direction"
                >
                  {t("Character performance direction")}
                </h4>
                <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t(
                    "Choose how this voice attracts and engages the listener. The reference recording still owns identity.",
                  )}
                </p>
              </div>
            </div>
            <VoiceDeliveryEditor
              delivery={cloneDelivery}
              disabled={!canWrite || busy}
              onChange={setCloneDelivery}
              t={t}
            />
          </section>

          <div className="border-t border-[var(--ad-border)] p-5 sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
                  {t("Candidate readiness")}
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {t("{done} of {total} required inputs ready", {
                    done: candidateReadyCount,
                    total: candidateReadiness.length,
                  })}
                </p>
                <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                  {candidateReadiness.map((item) => (
                    <li
                      className="inline-flex items-center gap-1.5 text-xs text-[var(--ad-text-muted)]"
                      key={item.label}
                    >
                      <CheckCircle2
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 ${
                          item.complete
                            ? "text-[var(--ad-green-text)]"
                            : "text-black/20"
                        }`}
                      />
                      {t(item.label)}
                      <span
                        className={
                          item.complete
                            ? "text-[var(--ad-green-text)]"
                            : "text-[var(--ad-text-muted)]"
                        }
                      >
                        {t(item.complete ? "Ready" : "Required")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <WorkspaceButton
                className="w-full lg:w-auto"
                disabled={
                  !canWrite ||
                  !data.voice.cloningAvailable ||
                  busy ||
                  candidateReadyCount !== candidateReadiness.length
                }
                tone="primary"
                type="submit"
              >
                {busy ? (
                  <AudioLines
                    aria-hidden="true"
                    className="h-4 w-4 animate-pulse"
                  />
                ) : (
                  <Upload aria-hidden="true" className="h-4 w-4" />
                )}
                {busy
                  ? t("Cloning and rendering preview…")
                  : t("Clone and render preview")}
              </WorkspaceButton>
            </div>
          </div>
        </form>

        <aside className="space-y-5 xl:sticky xl:top-5">
          <section
            aria-labelledby="live-voice-configuration"
            className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
            data-testid="live-voice-configuration"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Radio
                  aria-hidden="true"
                  className="h-4 w-4 text-[var(--ad-blue-text)]"
                />
                <h3
                  className="text-sm font-semibold"
                  id="live-voice-configuration"
                >
                  {t("Live voice configuration")}
                </h3>
              </div>
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-full bg-[var(--ad-green-text)] shadow-[0_0_0_3px_var(--ad-green-bg)]"
              />
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">
              {t("This is the authoritative voice used for new chat speech.")}
            </p>
            <div className="mt-4 border-t border-[var(--ad-border)] pt-4">
              {active ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge value={t("character override")} />
                    <span className="text-xs text-[var(--ad-text-muted)]">
                      {t("Voice version {version}", {
                        version: active.version,
                      })}
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-semibold">
                    {active.reference.filename}
                  </p>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {formatBytes(active.reference.sizeBytes, locale)} ·{" "}
                    {t(active.language)}
                  </p>
                  <VoiceDeliverySummary delivery={active.delivery} t={t} />
                  {active.preview ? (
                    <audio
                      aria-label={t("Active cloned voice preview")}
                      className="mt-4 w-full"
                      controls
                      preload="none"
                      src={active.preview.url}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      tone="good"
                      value={t("inherits system default")}
                    />
                  </div>
                  <p className="mt-3 text-sm font-semibold">
                    {t(voiceLabel(data, data.voice.effectiveVoiceId))}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                    {t(
                      "New speech uses this system default. Existing cached clips remain unchanged.",
                    )}
                  </p>
                  <VoiceDeliverySummary
                    delivery={data.voice.systemDefaults.delivery}
                    t={t}
                  />
                </>
              )}
            </div>
            {data.voice.currentVoiceId !== null ? (
              <div className="mt-4 border-t border-[var(--ad-border)] pt-4">
                <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t("Reason for restoring system default")}
                  <input
                    className={`${fieldClass} mt-1`}
                    disabled={!canActivate || busy}
                    minLength={3}
                    onChange={(event) => setResetReason(event.target.value)}
                    value={resetReason}
                  />
                </label>
                <WorkspaceButton
                  className="mt-3 w-full"
                  disabled={
                    !canActivate || busy || resetReason.trim().length < 3
                  }
                  onClick={() => void resetToSystemDefault()}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" className="h-4 w-4" />
                  {busy
                    ? t("Restoring system default…")
                    : t("Use system default voice")}
                </WorkspaceButton>
              </div>
            ) : null}
          </section>

          <section
            aria-labelledby="voice-runtime-route"
            className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
          >
            <div className="flex items-center gap-2">
              <Activity
                aria-hidden="true"
                className="h-4 w-4 text-[var(--ad-blue-text)]"
              />
              <h3 className="text-sm font-semibold" id="voice-runtime-route">
                {t("Runtime route")}
              </h3>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 rounded-full ${
                  data.voice.cloningAvailable
                    ? "bg-[var(--ad-green-text)]"
                    : "bg-[var(--ad-yellow-text)]"
                }`}
              />
              <span className="text-sm font-semibold">
                {t(voiceRuntimeLabel(data.voice.runtimeStatus))}
              </span>
            </div>
            <dl className="mt-4 grid gap-3 text-xs">
              <div className="flex items-center justify-between gap-4 border-t border-[var(--ad-border)] pt-3">
                <dt className="text-[var(--ad-text-muted)]">{t("Provider")}</dt>
                <dd className="font-semibold">{t("Fish Audio S2 Pro")}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-[var(--ad-border)] pt-3">
                <dt className="text-[var(--ad-text-muted)]">{t("Engine")}</dt>
                <dd className="font-semibold">
                  {data.voice.runtimeEngine === "mlx_audio"
                    ? `MLX ${data.voice.runtimeVersion ?? ""}`.trim()
                    : data.voice.runtimeEngine}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-[var(--ad-border)] pt-3">
                <dt className="text-[var(--ad-text-muted)]">{t("Language")}</dt>
                <dd className="font-semibold">
                  {t(data.voice.runtimeLanguage)}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>

      <details
        className="group overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]"
        data-testid="system-voice-defaults"
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]">
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
                  value={
                    data.voice.systemDefaults.source === "app_setting"
                      ? t("saved in Admin")
                      : t("environment fallback")
                  }
                />
                <StatusBadge
                  value={`${t("version")} ${data.voice.systemDefaults.settingVersion}`}
                />
                {data.voice.authoritySource === "system_default" ? (
                  <StatusBadge tone="good" value={t("used here")} />
                ) : null}
              </div>
            </div>
          </div>
          <span className="shrink-0 rounded-md border border-[var(--ad-border)] px-3 py-2 text-xs font-semibold text-[var(--ad-text-muted)]">
            <span className="group-open:hidden">
              {t("Open system defaults")}
            </span>
            <span className="hidden group-open:inline">
              {t("Close system defaults")}
            </span>
          </span>
        </summary>
        <div
          aria-labelledby="system-voice-defaults-title"
          className="border-t border-[var(--ad-border)] p-5 sm:p-6"
        >
          <div className="grid gap-5 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
            <VoiceDefaultSelect
              active={data.voice.authoritySource === "system_default"}
              busy={previewBusy}
              catalog={data.voice.systemDefaults.catalog}
              inputId="system-voice-default-global"
              label={t("System female identity")}
              onChange={(defaultVoiceId) =>
                setDefaultDraftOverride({
                  ...defaultDraft,
                  defaultVoiceId,
                  genderVoiceIds: {
                    female: defaultVoiceId,
                    male: defaultVoiceId,
                    trans: defaultVoiceId,
                  },
                })
              }
              onPreview={previewCatalogVoice}
              t={t}
              value={defaultDraft.defaultVoiceId}
            />
            <div className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-4">
              <div className="mb-4">
                <h4 className="text-sm font-semibold">
                  {t("System performance direction")}
                </h4>
                <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
                  {t(
                    "Set the sensual character of every inherited voice. Identity and performance stay separate.",
                  )}
                </p>
              </div>
              <VoiceDeliveryEditor
                disabled={!canManageDefaults || busy}
                delivery={defaultDraft.delivery}
                onChange={(delivery) =>
                  setDefaultDraftOverride({
                    ...defaultDraft,
                    delivery,
                  })
                }
                t={t}
              />
            </div>
          </div>
          {catalogPreview ? (
            <div className="mt-4 grid gap-3 rounded-lg bg-[var(--ad-blue-bg)] p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <p className="text-sm font-semibold text-[var(--ad-blue-text)]">
                  {t("Previewing {voice}", {
                    voice: t(voiceLabel(data, catalogPreview.voiceId)),
                  })}
                </p>
                <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                  {t("Listen before saving the default mapping.")}
                </p>
              </div>
              <audio
                aria-label={t("System voice preview")}
                autoPlay
                className="w-full sm:w-72"
                controls
                src={catalogPreview.src}
              />
            </div>
          ) : null}
          <div className="mt-5 grid gap-3 border-t border-[var(--ad-border)] pt-4 md:grid-cols-[1fr_auto] md:items-end">
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("System default change reason")}
              <input
                className={`${fieldClass} mt-1`}
                disabled={!canManageDefaults || busy}
                minLength={3}
                onChange={(event) => setDefaultReason(event.target.value)}
                value={defaultReason}
              />
            </label>
            <WorkspaceButton
              disabled={
                !canManageDefaults || busy || defaultReason.trim().length < 3
              }
              onClick={() => void saveSystemDefaults()}
              tone="primary"
              type="button"
            >
              <Save aria-hidden="true" className="h-4 w-4" />
              {busy ? t("Saving defaults…") : t("Save system defaults")}
            </WorkspaceButton>
          </div>
          {!canManageDefaults ? (
            <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
              {t(
                "Read-only: generation.config.write is required to change system voice defaults.",
              )}
            </p>
          ) : null}
        </div>
      </details>

      {archivedProfiles.length > 0 ? (
        <details className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5">
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <History
                aria-hidden="true"
                className="h-4 w-4 text-[var(--ad-blue-text)]"
              />
              {t("Voice history")}
            </span>
            <StatusBadge value={`${archivedProfiles.length}`} />
          </summary>
          <div className="grid gap-3 border-t border-[var(--ad-border)] p-5 sm:grid-cols-2">
            {archivedProfiles.map((profile) => (
              <article
                className="rounded-lg bg-[var(--ad-surface-subtle)] p-3 text-sm"
                key={profile.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>
                    {t("Voice version {version}", {
                      version: profile.version,
                    })}
                  </strong>
                  <StatusBadge value={profile.status} />
                </div>
                <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                  {profile.reference.filename} ·{" "}
                  {new Date(profile.createdAt).toLocaleString(
                    locale === "zh" ? "zh-CN" : "en-US",
                  )}
                </p>
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
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
                  ? "border-[var(--ad-blue-border)] bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
                  : "border-[var(--ad-border)] bg-[var(--ad-surface)] hover:border-[var(--ad-blue-border)]"
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
  catalog,
  inputId,
  label,
  onChange,
  onPreview,
  t,
  value,
}: {
  active: boolean;
  busy: FishAudioCatalogVoiceId | null;
  catalog: CharacterWorkspaceDetail["voice"]["systemDefaults"]["catalog"];
  inputId: string;
  label: string;
  onChange: (value: FishAudioCatalogVoiceId) => void;
  onPreview: (value: FishAudioCatalogVoiceId) => Promise<void>;
  t: (key: string, values?: Record<string, string | number>) => string;
  value: FishAudioCatalogVoiceId;
}) {
  const selected = catalog.find((voice) => voice.id === value);
  return (
    <article
      className={`rounded-lg border p-3 transition-colors ${
        active
          ? "border-[var(--ad-blue-border)] bg-[var(--ad-blue-bg)]"
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
        onChange={(event) =>
          onChange(event.target.value as FishAudioCatalogVoiceId)
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
          {selected ? t(selected.description) : "—"}
        </span>
        <WorkspaceButton
          aria-label={t("Preview {voice}", {
            voice: selected?.label ?? value,
          })}
          disabled={busy !== null}
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

function voiceLabel(data: CharacterWorkspaceDetail, voiceId: string) {
  return (
    data.voice.systemDefaults.catalog.find((voice) => voice.id === voiceId)
      ?.label ?? voiceId
  );
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

function formatBytes(value: number, locale: "en" | "zh") {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    style: "unit",
    unit: value >= 1024 * 1024 ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value / (value >= 1024 * 1024 ? 1024 * 1024 : 1024));
}

function voiceRuntimeLabel(
  status: CharacterWorkspaceDetail["voice"]["runtimeStatus"],
) {
  return {
    ready: "clone ready",
    unavailable: "clone service unavailable",
    inactive: "clone provider inactive",
  }[status];
}

function voiceRuntimeMessage(
  status: CharacterWorkspaceDetail["voice"]["runtimeStatus"],
) {
  return {
    ready: "Fish Audio S2 Pro voice cloning through MLX is ready.",
    unavailable:
      "Fish Audio is configured but unavailable. Verify the fish-audio-s2-pro-8bit model, resident MLX process, and system female reference.",
    inactive:
      "Fish Audio is not the active voice provider. Set VOICE_PROVIDER=fish-audio and start the Fish Audio process.",
  }[status];
}
