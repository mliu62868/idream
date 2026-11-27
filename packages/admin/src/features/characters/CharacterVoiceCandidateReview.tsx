"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { CheckCircle2 } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import type { OperatorErrorCopy } from "@/components/admin/ui/request-error-copy";
import { StatusBadge, WorkspaceButton } from "@/features/operations/WorkspaceUi";
import { VoiceDeliverySummary, voiceProviderLabel } from "@/features/voice/VoiceSettingsControls";
import { CHARACTER_IMMEDIATE_EFFECT_COPY } from "./character-immediate-effects";
import { voiceProfileName, type VoiceProfile } from "./character-voice-model";
import { ActionErrorAlert } from "./CharacterVoiceAlerts";

// SPEC: 有候选声音时的主动作：先试听，再激活。激活绕过发布直接改线上，
// 所以「立即生效」标示必须贴着激活按钮。
export function CharacterVoiceCandidateReview({
  data,
  candidate,
  canActivate,
  busy,
  activating,
  actionError,
  onActivate,
}: {
  data: CharacterWorkspaceDetail;
  candidate: VoiceProfile;
  canActivate: boolean;
  busy: boolean;
  activating: boolean;
  actionError: OperatorErrorCopy | null;
  onActivate: () => void;
}) {
  const { t } = useAdminI18n();
  const activationProviderAvailable = data.voice.candidateRuntimeStatus === "ready";
  return (
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
              {voiceProviderLabel(candidate.provider, candidate.model)} · v{candidate.version}
            </span>
          </div>
          <h3 className="mt-2 text-lg font-semibold text-[var(--ad-ink)]" id="voice-candidate-review-title">
            {t("Listen to {voice} before activating it", { voice: voiceProfileName(data.voice, candidate, t) })}
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
            onClick={onActivate}
            tone="primary"
            type="button"
          >
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
            {activating ? t("Activating voice…") : t("Activate voice")}
          </WorkspaceButton>
          <p className="text-xs font-semibold leading-5 text-[var(--ad-yellow-text)]" data-testid="voice-effect-note">
            {t(CHARACTER_IMMEDIATE_EFFECT_COPY)}
          </p>
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
      {actionError ? (
        <div className="px-5 pb-5 sm:px-6">
          <ActionErrorAlert copy={actionError} t={t} />
        </div>
      ) : null}
    </section>
  );
}
