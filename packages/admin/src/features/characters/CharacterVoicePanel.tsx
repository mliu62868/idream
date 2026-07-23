"use client";

import {
  characterVoiceActivationResponseSchema,
  characterVoiceCloneCreateResponseSchema,
  type CharacterWorkspaceDetail,
} from "@idream/shared/admin";
import { AudioLines, CheckCircle2, Mic2, Upload } from "lucide-react";
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
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  canActivate: boolean;
  runCommittedMutation: RunCommittedMutation;
}) {
  const { t, locale } = useAdminI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sampleText, setSampleText] = useState(
    `Hello, I’m ${data.character.name}. It’s good to hear from you.`,
  );
  const [reason, setReason] = useState("");
  const [activationReason, setActivationReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = data.voice.activeProfile;
  const candidate = data.voice.candidateProfile;
  const activationProviderAvailable =
    data.voice.provider === "pocket_tts" &&
    data.voice.runtimeStatus !== "inactive";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const form = new FormData();
    form.set("audio", file, file.name);
    form.set("language", data.voice.runtimeLanguage);
    form.set("sampleText", sampleText.trim());
    form.set("reason", reason.trim());
    try {
      const mutation = await runCommittedMutation({
        action: "Pocket TTS voice clone",
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
          setReason("");
          if (fileInput.current) fileInput.current.value = "";
        },
      });
      setMessage(
        mutation.result.replayed
          ? t("The existing voice candidate result was recovered.")
          : t("The voice candidate is ready. Review its preview before activation."),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Voice cloning failed"));
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
        action: "Activate Pocket TTS voice",
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
          ? t("The existing voice activation result was recovered.")
          : t("The reviewed voice is now active for new chat speech."),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Voice activation failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section
        aria-labelledby="character-voice-authority"
        className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">
              {t("Character voice")}
            </p>
            <h3 className="mt-1 text-xl font-semibold" id="character-voice-authority">
              {active ? t("Active cloned voice") : t("No cloned voice yet")}
            </h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
              {active
                ? t("New chat speech uses this Pocket TTS voice. Existing cached clips remain unchanged.")
                : t("Upload one clean voice sample, verify the generated preview, and bind it to this character.")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge
              value={
                data.voice.runtimeEngine === "pocket_tts_mlx"
                  ? `Pocket TTS · MLX ${data.voice.runtimeVersion ?? ""}`.trim()
                  : data.voice.provider
              }
            />
            <StatusBadge
              tone={data.voice.cloningAvailable ? "good" : "warn"}
              value={voiceRuntimeLabel(data.voice.runtimeStatus)}
            />
          </div>
        </div>
        {active ? (
          <div className="mt-5 grid gap-4 rounded-lg bg-[var(--ad-surface-subtle)] p-4 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="text-sm font-semibold">
                {t("Voice version {version}", { version: active.version })}
              </p>
              <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                {active.reference.filename} · {formatBytes(active.reference.sizeBytes, locale)} ·{" "}
                {t(active.language)} · {new Date(active.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}
              </p>
              <p className="mt-2 text-sm">{active.sampleText}</p>
            </div>
            {active.preview ? (
              <audio
                aria-label={t("Active cloned voice preview")}
                className="w-full md:w-72"
                controls
                preload="none"
                src={active.preview.url}
              />
            ) : null}
          </div>
        ) : null}
      </section>

      {candidate ? (
        <section
          aria-labelledby="voice-candidate-review"
          className="rounded-xl border border-[var(--ad-blue-border)] bg-[var(--ad-blue-bg)] p-5"
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-blue-text)]">
                {t("Candidate preview")}
              </p>
              <h3 className="mt-1 text-lg font-semibold" id="voice-candidate-review">
                {t("Review voice version {version}", { version: candidate.version })}
              </h3>
              <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
                {t("Listen to the preview before changing the live character voice. Creating a candidate never changes Character.voiceId.")}
              </p>
            </div>
            {candidate.preview ? (
              <audio
                aria-label={t("Candidate voice preview")}
                className="w-full md:w-72"
                controls
                preload="metadata"
                src={candidate.preview.url}
              />
            ) : null}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Activation reason")}
              <input
                className={`${fieldClass} mt-1`}
                disabled={!canActivate || !activationProviderAvailable || busy}
                id="character-voice-activation-reason"
                minLength={3}
                name="activationReason"
                onChange={(event) => setActivationReason(event.target.value)}
                value={activationReason}
              />
            </label>
            <WorkspaceButton
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
              {busy ? t("Activating reviewed voice…") : t("Activate reviewed voice")}
            </WorkspaceButton>
          </div>
          {!canActivate ? (
            <p className="mt-3 text-xs text-[var(--ad-text-muted)]">
              {t("Read-only: character.release.publish is required to activate a voice.")}
            </p>
          ) : null}
          {canActivate && !activationProviderAvailable ? (
            <p className="mt-3 text-xs text-[var(--ad-yellow-text)]" role="alert">
              {t("Pocket TTS must be the active voice provider before this candidate can be activated.")}
            </p>
          ) : null}
        </section>
      ) : null}

      <form
        className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]">
            <Mic2 aria-hidden="true" className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-semibold">
              {candidate ? t("Replace voice candidate") : t("Create voice candidate")}
            </h3>
            <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
              {t("Use a clean single-speaker recording. Pocket TTS MLX uses up to the first 30 seconds.")}
            </p>
          </div>
        </div>
        {!data.voice.cloningAvailable ? (
          <p className="mt-4 rounded-lg bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]" role="alert">
            {t(voiceRuntimeMessage(data.voice.runtimeStatus))}
          </p>
        ) : null}
        <div className="mt-5 grid gap-4">
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Voice reference audio")}
            <input
              accept=".wav,.mp3,.flac,.ogg,audio/wav,audio/mpeg,audio/flac,audio/ogg"
              className={`${fieldClass} mt-1 file:mr-3 file:rounded file:border-0 file:bg-[var(--ad-surface-subtle)] file:px-3 file:py-2 file:text-xs file:font-semibold`}
              disabled={!canWrite || !data.voice.cloningAvailable || busy}
              id="character-voice-reference"
              name="audio"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              ref={fileInput}
              required
              type="file"
            />
            <span className="mt-1 block font-normal">
              {t("WAV, MP3, FLAC, or OGG · maximum 15 MB")}
            </span>
          </label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
            {t("Preview script")}
            <textarea
              className={`${textAreaClass} mt-1`}
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
          </label>
        </div>
        {error ? (
          <p className="mt-4 rounded-lg bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="mt-4 rounded-lg bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" role="status">
            {message}
          </p>
        ) : null}
        <div className="mt-5">
          <WorkspaceButton
            disabled={
              !canWrite ||
              !data.voice.cloningAvailable ||
              busy ||
              !file ||
              sampleText.trim().length < 3 ||
              reason.trim().length < 3
            }
            tone="primary"
            type="submit"
          >
            {busy ? (
              <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
            ) : (
              <Upload aria-hidden="true" className="h-4 w-4" />
            )}
            {busy ? t("Cloning and rendering preview…") : t("Clone and render preview")}
          </WorkspaceButton>
        </div>
      </form>

      {data.voice.history.filter((profile) =>
        profile.id !== active?.id && profile.id !== candidate?.id
      ).length > 0 ? (
        <section
          aria-labelledby="voice-history"
          className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
        >
          <h3 className="font-semibold" id="voice-history">{t("Voice history")}</h3>
          <div className="mt-4 grid gap-3">
            {data.voice.history
              .filter((profile) =>
                profile.id !== active?.id && profile.id !== candidate?.id
              )
              .map((profile) => (
                <article className="rounded-lg bg-[var(--ad-surface-subtle)] p-3 text-sm" key={profile.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>{t("Voice version {version}", { version: profile.version })}</strong>
                    <StatusBadge value={profile.status} />
                  </div>
                  <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
                    {profile.reference.filename} · {new Date(profile.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}
                  </p>
                </article>
              ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function formatBytes(value: number, locale: "en" | "zh") {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    style: "unit",
    unit: value >= 1024 * 1024 ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value / (value >= 1024 * 1024 ? 1024 * 1024 : 1024));
}

function voiceRuntimeLabel(status: CharacterWorkspaceDetail["voice"]["runtimeStatus"]) {
  return {
    ready: "clone ready",
    model_access_required: "model access required",
    unavailable: "clone service unavailable",
    inactive: "clone provider inactive",
  }[status];
}

function voiceRuntimeMessage(status: CharacterWorkspaceDetail["voice"]["runtimeStatus"]) {
  return {
    ready: "Pocket TTS MLX voice cloning is ready.",
    model_access_required:
      "Pocket TTS MLX speech is running, but clone weights require model access. Accept the kyutai/pocket-tts model terms, provide HF_TOKEN, and restart the Pocket TTS process.",
    unavailable:
      "Pocket TTS MLX is configured but unreachable. Start or restart the Pocket TTS process.",
    inactive:
      "Pocket TTS is not the active voice provider. Set VOICE_PROVIDER=pocket-tts and start the Pocket TTS process.",
  }[status];
}
