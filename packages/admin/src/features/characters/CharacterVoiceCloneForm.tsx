"use client";

import {
  DEFAULT_FISH_AUDIO_DELIVERY,
  type CharacterWorkspaceDetail,
  type FishAudioDeliverySettings,
} from "@idream/shared/admin";
import { AudioLines, Upload } from "lucide-react";
import { useState, type FormEvent, type RefObject } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import type { OperatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { WorkspaceButton, textAreaClass } from "@/features/operations/WorkspaceUi";
import { VoiceDeliveryEditor } from "@/features/voice/VoiceSettingsControls";
import { cn } from "@/lib/utils";
import {
  cloneReadiness,
  cloneStatusDetail,
  defaultCloneSampleText,
  voiceReferenceTranscriptHelp,
  type ModelStatus,
} from "./character-voice-model";
import { ActionErrorAlert, InlineAlert } from "./CharacterVoiceAlerts";

export type VoiceCloneDraftState = ReturnType<typeof useCharacterVoiceCloneDraft>;

// INVARIANT: 克隆草稿归面板而不归表单 —— 运营在「官方声音 / 克隆」之间来回切换时，
// 已选的参考音频、转写与试听脚本都不能丢。
// 文件输入框的 ref 归面板持有（render 期不读 ref）；clearReference 只清草稿状态。
export function useCharacterVoiceCloneDraft(data: CharacterWorkspaceDetail, locale: string) {
  const [file, setFile] = useState<File | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [sampleText, setSampleText] = useState(
    defaultCloneSampleText(data.voice.provider, locale, data.character.name),
  );
  const [delivery, setDelivery] = useState<FishAudioDeliverySettings>({
    ...DEFAULT_FISH_AUDIO_DELIVERY,
  });
  const readiness = cloneReadiness({ file, referenceText, sampleText });
  const readyCount = readiness.filter(Boolean).length;
  return {
    file,
    setFile,
    referenceText,
    setReferenceText,
    sampleText,
    setSampleText,
    delivery,
    setDelivery,
    readiness,
    readyCount,
    ready: readyCount === readiness.length,
    // After a committed clone the reference is consumed; the preview script stays.
    clearReference: () => {
      setFile(null);
      setReferenceText("");
    },
  };
}

// SPEC: 二级能力：上传参考录音克隆专属声音，先渲染试听候选，激活另走候选审阅。
export function CharacterVoiceCloneForm({
  data,
  draft,
  fileInputRef,
  canWrite,
  busy,
  cloning,
  cloneStatus,
  actionError,
  onSubmit,
}: {
  data: CharacterWorkspaceDetail;
  draft: VoiceCloneDraftState;
  fileInputRef: RefObject<HTMLInputElement | null>;
  canWrite: boolean;
  busy: boolean;
  cloning: boolean;
  cloneStatus: ModelStatus;
  actionError: OperatorErrorCopy | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useAdminI18n();
  const voice = data.voice;
  return (
    <form id="voice-candidate-builder" onSubmit={onSubmit}>
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
              onChange={(event) => draft.setFile(event.target.files?.[0] ?? null)}
              ref={fileInputRef}
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
                {draft.file?.name ?? t("No audio selected")}
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
              onChange={(event) => draft.setReferenceText(event.target.value)}
              placeholder={t("Enter the exact words spoken in the reference recording.")}
              value={draft.referenceText}
            />
            <span className="mt-1 block font-normal">
              {t(voiceReferenceTranscriptHelp(voice.provider, voice.runtimeModel))}
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
              onChange={(event) => draft.setSampleText(event.target.value)}
              value={draft.sampleText}
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
              delivery={draft.delivery}
              runtimeModel={voice.runtimeModel}
              disabled={!canWrite || busy}
              onChange={draft.setDelivery}
              t={t}
            />
          </div>
        </section>
      ) : null}
      {actionError ? (
        <div className="px-5 sm:px-6">
          <ActionErrorAlert copy={actionError} t={t} />
        </div>
      ) : null}
      <div className="mt-6 flex flex-col gap-3 border-t border-[var(--ad-border)] bg-[var(--ad-surface-subtle)]/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-sm text-[var(--ad-text-muted)]">
          {t("{done} of {total} required inputs ready", {
            done: draft.readyCount,
            total: draft.readiness.length,
          })}
        </p>
        <WorkspaceButton
          disabled={!canWrite || cloneStatus !== "ready" || busy || !draft.ready}
          tone="primary"
          type="submit"
        >
          {cloning ? (
            <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
          ) : (
            <Upload aria-hidden="true" className="h-4 w-4" />
          )}
          {cloning ? t("Cloning and rendering preview…") : t("Clone and render preview")}
        </WorkspaceButton>
      </div>
    </form>
  );
}
