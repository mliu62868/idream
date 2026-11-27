"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useRef, useState, type FormEvent } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { voiceProviderLabel } from "@/features/voice/VoiceSettingsControls";
import { CHARACTER_IMMEDIATE_EFFECT_COPY } from "./character-immediate-effects";
import {
  catalogVoiceLabel,
  cloneModelStatus,
  defaultPresetSampleText,
  defaultVoiceModel,
  livePresetVoiceId as resolveLivePresetVoiceId,
  resolveSelectedPresetVoiceId,
  voiceAuthorityReviewKey,
  voiceIdForGender,
  voicePreviewSignature,
  type ModelStatus,
  type RunCommittedMutation,
  type VoiceModel,
} from "./character-voice-model";
import { CharacterVoiceCandidateReview } from "./CharacterVoiceCandidateReview";
import { CharacterVoiceCloneForm, useCharacterVoiceCloneDraft } from "./CharacterVoiceCloneForm";
import { CharacterVoiceLiveCard } from "./CharacterVoiceLiveCard";
import { CharacterVoiceModelPicker } from "./CharacterVoiceModelPicker";
import { CharacterVoiceOfficialPicker } from "./CharacterVoiceOfficialPicker";
import { CharacterVoiceProfileHistory } from "./CharacterVoiceProfileHistory";
import { CharacterVoiceSystemDefaultsNote } from "./CharacterVoiceSystemDefaultsNote";
import { useCharacterVoicePreview } from "./use-character-voice-preview";
import { useCharacterVoiceWrites } from "./use-character-voice-writes";
import { VoiceCallHistory } from "./VoiceCallHistory";

// SPEC: 角色声音面板只负责编排。日常主路径自上而下：当前线上声音（试听 / 恢复系统默认）
// → 待审候选（试听 / 激活）→ 换声音（官方声音选择、试听、一键应用）。二级能力：声音克隆、
// 声音历史、通话记录。全平台默认声音只给去处，不在这里编辑。
// Only reset reaches beyond this pick and gets a ConfirmDialog: it drops this
// Character's own voice. reviewKey pins the live authority a reset was opened against:
// if the live voice changes underneath, the review silently lapses.
// INTENT: the platform-wide voice defaults used to be editable here too, so one click on
//         one Character changed every inheriting Character. They now live on the platform
//         configuration page (Profiles & Rollout → Voice defaults).
type DialogIntent = { readonly kind: "reset"; readonly reviewKey: string };

export function CharacterVoicePanel({
  data,
  canWrite,
  canActivate,
  canPreview,
  runCommittedMutation,
  takeIdempotencyKey,
  releaseIdempotencyKey,
  bindVoiceProfile,
  releaseVoiceProfileKeys,
}: {
  data: CharacterWorkspaceDetail;
  canWrite: boolean;
  canActivate: boolean;
  canPreview: boolean;
  runCommittedMutation: RunCommittedMutation;
  /**
   * SPEC: 同一个业务签名跨刷新拿到同一个幂等键；写入落地后由 afterRefresh 释放。
   * INTENT: 这四处原本每次点击现开一个 crypto.randomUUID()，于是一次网络抖动后的重试就是
   *         第二次真实写入 —— 声音克隆会重复扣费，激活/重置会重复改线上音色。
   */
  takeIdempotencyKey: (signature: string) => string;
  releaseIdempotencyKey: (signature: string) => void;
  bindVoiceProfile: (signature: string, key: string, profileId: string) => void;
  releaseVoiceProfileKeys: (profileId: string) => void;
}) {
  const { t, locale } = useAdminI18n();
  const voice = data.voice;
  const active = voice.activeProfile;
  const candidate = voice.candidateProfile;

  const cloneFileInput = useRef<HTMLInputElement>(null);
  const cloneDraft = useCharacterVoiceCloneDraft(data, locale);

  const officialStatus: ModelStatus = voice.presetRuntime.runtimeStatus;
  const cloneStatus = cloneModelStatus(voice);
  const [modelChoice, setModelChoice] = useState<VoiceModel | null>(null);
  const model = modelChoice ?? defaultVoiceModel(active, officialStatus);

  const livePresetVoiceId = resolveLivePresetVoiceId(voice);
  const [presetChoice, setPresetChoice] = useState<string | null>(null);
  const selectedPresetVoiceId = resolveSelectedPresetVoiceId(
    presetChoice,
    livePresetVoiceId,
    voice.presetRuntime.catalogVoiceIds,
  );
  const [presetSampleText, setPresetSampleText] = useState(
    defaultPresetSampleText(data.character.name),
  );
  const auditionText = presetSampleText.trim();

  const writes = useCharacterVoiceWrites({
    data,
    runCommittedMutation,
    takeIdempotencyKey,
    releaseIdempotencyKey,
    bindVoiceProfile,
    releaseVoiceProfileKeys,
  });
  const { busy, busyAction, actionError } = writes;
  const preview = useCharacterVoicePreview({ data, locale, canPreview, busy, auditionText });

  const authorityReviewKey = voiceAuthorityReviewKey(data.character.id, voice);
  const [dialog, setDialog] = useState<DialogIntent | null>(null);
  const livePreviewSignature = voicePreviewSignature(
    data.character.id,
    voice,
    voice.effectiveVoiceId,
    voice.systemDefaults.delivery,
    "live",
  );

  function auditionOfficialVoice(voiceId: string) {
    setPresetChoice(voiceId);
    void preview.previewCatalogVoice(voiceId, "audition");
  }

  function applyOfficialVoice(voiceId: string, activate: boolean) {
    return writes.applyOfficialVoice({
      voiceId,
      sampleText: auditionText,
      activate,
      appliedMessage: t("Voice changed. New chat speech now uses {voice}.", {
        voice: catalogVoiceLabel(voice, voiceId),
      }),
      onApplied: () => setPresetChoice(null),
    });
  }

  function submitClone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cloneDraft.ready) return;
    const file = cloneDraft.file;
    if (!file) return;
    void writes.createClone({
      draft: {
        file,
        language: voice.runtimeLanguage,
        referenceText: cloneDraft.referenceText,
        sampleText: cloneDraft.sampleText,
        delivery: cloneDraft.delivery,
      },
      providerLabel: voiceProviderLabel(voice.provider, voice.runtimeModel),
      onCommitted: () => {
        cloneDraft.clearReference();
        if (cloneFileInput.current) cloneFileInput.current.value = "";
      },
    });
  }

  const dialogOpen = dialog !== null && dialog.reviewKey === authorityReviewKey;
  const dialogSpec: ConfirmSpec | null = dialog && dialogOpen ? {
    title: "Use system default voice",
    summary: (
      <div className="space-y-2">
        <p>
          {t("{character} goes back to inheriting the system default voice {voice}.", {
            character: data.character.name,
            voice: catalogVoiceLabel(
              voice,
              voiceIdForGender(voice.systemDefaults, data.character.gender),
            ),
          })}
        </p>
        <p className="font-semibold" data-testid="voice-reset-effect-note">
          {t(CHARACTER_IMMEDIATE_EFFECT_COPY)}
        </p>
      </div>
    ),
    requireReason: false,
    submitLabel: "Use system default voice",
    onSubmit: async () => {
      await writes.resetToSystemDefault(canActivate);
      setDialog(null);
    },
  } : null;

  return (
    <div className="space-y-6">
      <CharacterVoiceLiveCard
        busy={busy}
        canActivate={canActivate}
        canPreview={canPreview}
        catalogPreview={preview.catalogPreview}
        data={data}
        livePreviewSignature={livePreviewSignature}
        onPreviewLive={() => void preview.previewCatalogVoice(voice.effectiveVoiceId, "live")}
        onRequestReset={() => setDialog({ kind: "reset", reviewKey: authorityReviewKey })}
        previewBusy={preview.previewBusy}
        previewError={preview.error}
        resetting={busyAction === "reset"}
      />

      {writes.message ? (
        <p
          className="rounded-lg bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]"
          role="status"
        >
          {t(writes.message)}
        </p>
      ) : null}

      {candidate ? (
        <CharacterVoiceCandidateReview
          actionError={actionError?.action === "activate" ? actionError.copy : null}
          activating={busyAction === "activate"}
          busy={busy}
          canActivate={canActivate}
          candidate={candidate}
          data={data}
          onActivate={() => void writes.activateCandidate()}
        />
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

        <CharacterVoiceModelPicker
          cloneStatus={cloneStatus}
          data={data}
          model={model}
          officialStatus={officialStatus}
          onSelect={setModelChoice}
        />

        {model === "official" ? (
          <CharacterVoiceOfficialPicker
            actionError={actionError?.action === "preset" ? actionError.copy : null}
            applying={busyAction === "preset"}
            busy={busy}
            canActivate={canActivate}
            canPreview={canPreview}
            canWrite={canWrite}
            catalogPreview={preview.catalogPreview}
            data={data}
            livePresetVoiceId={livePresetVoiceId}
            officialStatus={officialStatus}
            onApply={() => void applyOfficialVoice(selectedPresetVoiceId, canActivate)}
            onAuditionVoice={auditionOfficialVoice}
            onPresetSampleTextChange={setPresetSampleText}
            onSelectVoice={setPresetChoice}
            presetSampleText={presetSampleText}
            previewBusy={preview.previewBusy}
            previewError={preview.error}
            selectedPresetVoiceId={selectedPresetVoiceId}
          />
        ) : (
          <CharacterVoiceCloneForm
            actionError={actionError?.action === "clone" ? actionError.copy : null}
            busy={busy}
            canWrite={canWrite}
            cloneStatus={cloneStatus}
            cloning={busyAction === "clone"}
            data={data}
            draft={cloneDraft}
            fileInputRef={cloneFileInput}
            onSubmit={submitClone}
          />
        )}
      </section>

      <CharacterVoiceProfileHistory data={data} />

      <CharacterVoiceSystemDefaultsNote voice={voice} />

      <VoiceCallHistory key={data.character.id} characterId={data.character.id} />
      {dialogSpec ? <ConfirmDialog onClose={() => setDialog(null)} spec={dialogSpec} /> : null}
    </div>
  );
}
