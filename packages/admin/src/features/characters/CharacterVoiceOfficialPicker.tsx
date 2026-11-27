"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { AudioLines, Check, Play } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import type { OperatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { WorkspaceButton, textAreaClass } from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";
import { CHARACTER_IMMEDIATE_EFFECT_COPY } from "./character-immediate-effects";
import {
  AUDITION_MAX_CHARS,
  catalogVoiceLabel,
  officialStatusDetail,
  voicePreviewSignature,
  type ModelStatus,
  type Translate,
} from "./character-voice-model";
import { ActionErrorAlert, InlineAlert } from "./CharacterVoiceAlerts";
import type { CatalogVoicePreview, CatalogVoicePreviewError } from "./use-character-voice-preview";

// SPEC: 日常主路径：在官方声音里选一个、试听、一键应用为角色声音。
// 有发布权时应用即激活（立即生效）；没有时只提交候选，等有权限的同事激活。
export function CharacterVoiceOfficialPicker({
  data,
  canWrite,
  canActivate,
  canPreview,
  busy,
  applying,
  officialStatus,
  selectedPresetVoiceId,
  livePresetVoiceId,
  presetSampleText,
  previewBusy,
  catalogPreview,
  previewError,
  actionError,
  onPresetSampleTextChange,
  onSelectVoice,
  onAuditionVoice,
  onApply,
}: {
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  canActivate: boolean;
  canPreview: boolean;
  busy: boolean;
  applying: boolean;
  officialStatus: ModelStatus;
  selectedPresetVoiceId: string;
  livePresetVoiceId: string | null;
  presetSampleText: string;
  previewBusy: string | null;
  catalogPreview: CatalogVoicePreview | null;
  previewError: CatalogVoicePreviewError | null;
  actionError: OperatorErrorCopy | null;
  onPresetSampleTextChange: (value: string) => void;
  onSelectVoice: (voiceId: string) => void;
  onAuditionVoice: (voiceId: string) => void;
  onApply: () => void;
}) {
  const { t } = useAdminI18n();
  const voice = data.voice;
  const active = voice.activeProfile;
  const catalogVoiceIds = voice.presetRuntime.catalogVoiceIds;
  const auditionText = presetSampleText.trim();
  const auditionSignature = voicePreviewSignature(
    data.character.id,
    voice,
    selectedPresetVoiceId,
    voice.systemDefaults.delivery,
    auditionText,
  );
  const selectedIsLiveOverride =
    active !== null && active.presetVoiceId === selectedPresetVoiceId;
  const officialApplyReady =
    canWrite &&
    officialStatus === "ready" &&
    selectedPresetVoiceId.length > 0 &&
    auditionText.length >= 3 &&
    !selectedIsLiveOverride;

  return (
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
              label={catalogVoiceLabel(voice, voiceId)}
              onAudition={() => onAuditionVoice(voiceId)}
              onSelect={() => onSelectVoice(voiceId)}
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
          onChange={(event) => onPresetSampleTextChange(event.target.value)}
          value={presetSampleText}
        />
      </details>
      {officialStatus !== "ready" ? (
        <div className="px-5 sm:px-6">
          <InlineAlert tone="warn">{t(officialStatusDetail(officialStatus) ?? "")}</InlineAlert>
        </div>
      ) : null}
      {previewError?.scope === "audition" && previewError.signature === auditionSignature ? (
        <div className="px-5 sm:px-6">
          <InlineAlert tone="error">{t(previewError.text)}</InlineAlert>
        </div>
      ) : null}
      {actionError ? (
        <div className="px-5 sm:px-6">
          <ActionErrorAlert copy={actionError} t={t} />
        </div>
      ) : null}
      <div className="mt-5 flex flex-col gap-4 border-t border-[var(--ad-border)] bg-[var(--ad-surface-subtle)]/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <p className="text-sm">
            <span className="text-[var(--ad-text-muted)]">{t("Selected")} </span>
            <strong className="font-semibold text-[var(--ad-ink)]">
              {selectedPresetVoiceId ? catalogVoiceLabel(voice, selectedPresetVoiceId) : "—"}
            </strong>
          </p>
          {catalogPreview?.scope === "audition" &&
          catalogPreview.voiceId === selectedPresetVoiceId &&
          catalogPreview.signature === auditionSignature ? (
            <audio
              aria-label={t("Preview {voice}", { voice: catalogVoiceLabel(voice, selectedPresetVoiceId) })}
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
          onClick={onApply}
          tone="primary"
          type="button"
        >
          {applying ? (
            <AudioLines aria-hidden="true" className="h-4 w-4 animate-pulse" />
          ) : (
            <Check aria-hidden="true" className="h-4 w-4" />
          )}
          {applying
            ? t("Applying voice…")
            : selectedIsLiveOverride
              ? t("Already in use")
              : canActivate
                ? t("Use as character voice")
                : t("Submit as candidate")}
        </WorkspaceButton>
      </div>
      {canActivate ? (
        <p
          className="border-t border-[var(--ad-border)] px-5 py-2 text-xs font-semibold text-[var(--ad-yellow-text)] sm:px-6"
          data-testid="voice-apply-effect-note"
        >
          {t(CHARACTER_IMMEDIATE_EFFECT_COPY)}
        </p>
      ) : null}
      {!canWrite && !busy ? (
        <p className="border-t border-[var(--ad-border)] px-5 py-3 text-xs text-[var(--ad-text-muted)] sm:px-6">
          {t("Read-only: character write permission is required to change the voice.")}
        </p>
      ) : null}
    </div>
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
