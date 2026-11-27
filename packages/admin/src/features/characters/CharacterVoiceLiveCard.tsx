"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { AudioLines, Play, RotateCcw } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { StatusBadge, WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { deliveryPresetLabel, voiceProviderLabel } from "@/features/voice/VoiceSettingsControls";
import { CHARACTER_IMMEDIATE_EFFECT_COPY } from "./character-immediate-effects";
import { catalogVoiceLabel, voiceProfileName } from "./character-voice-model";
import { InlineAlert } from "./CharacterVoiceAlerts";
import type { CatalogVoicePreview, CatalogVoicePreviewError } from "./use-character-voice-preview";

// SPEC: 日常主路径的第一眼 —— 这个角色此刻线上用的是哪个声音、从哪来，能否试听，
// 以及「恢复系统默认」这个唯一需要确认的写入入口。
export function CharacterVoiceLiveCard({
  data,
  canActivate,
  canPreview,
  busy,
  resetting,
  previewBusy,
  catalogPreview,
  previewError,
  livePreviewSignature,
  onPreviewLive,
  onRequestReset,
}: {
  data: CharacterWorkspaceDetail;
  canActivate: boolean;
  canPreview: boolean;
  busy: boolean;
  resetting: boolean;
  previewBusy: string | null;
  catalogPreview: CatalogVoicePreview | null;
  previewError: CatalogVoicePreviewError | null;
  livePreviewSignature: string;
  onPreviewLive: () => void;
  onRequestReset: () => void;
}) {
  const { t } = useAdminI18n();
  const voice = data.voice;
  const active = voice.activeProfile;
  const liveProvider = active?.provider ?? voice.systemDefaults.provider;
  const liveVoiceName = active
    ? voiceProfileName(voice, active, t)
    : catalogVoiceLabel(voice, voice.effectiveVoiceId);

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
      onClick={onPreviewLive}
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
    <section
      aria-labelledby="character-voice-authority"
      className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5 sm:p-6"
      data-testid="voice-control-room"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--ad-text-muted)]" id="character-voice-authority">
              {t("Current live voice")}
            </h3>
            <StatusBadge tone="good" value={t("Live now")} />
          </div>
          <p className="mt-1 truncate text-2xl font-semibold tracking-[-0.01em] text-[var(--ad-ink)]">
            {liveVoiceName}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
            <MetaItem label={t("Model")} value={voiceProviderLabel(liveProvider, liveProvider === voice.provider ? voice.runtimeModel : active?.model)} />
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
              onClick={onRequestReset}
              type="button"
            >
              <RotateCcw aria-hidden="true" className="h-4 w-4" />
              {resetting ? t("Restoring system default…") : t("Use system default voice")}
            </WorkspaceButton>
          ) : null}
        </div>
      </div>
      {/* SPEC: 激活、重置都绕过发布直接改线上；动作所在的位置必须说出来。 */}
      <p
        className="mt-4 border-t border-[var(--ad-border)] pt-3 text-xs leading-5 text-[var(--ad-yellow-text)]"
        data-testid="voice-live-effect-note"
      >
        {t(CHARACTER_IMMEDIATE_EFFECT_COPY)}
      </p>
      {previewError?.scope === "live" && previewError.signature === livePreviewSignature ? <InlineAlert tone="error">{t(previewError.text)}</InlineAlert> : null}
    </section>
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
