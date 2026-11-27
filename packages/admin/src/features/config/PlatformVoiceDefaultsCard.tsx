"use client";

// SPEC: 全平台默认声音 —— 没有自定义声音的每一个角色都从这里继承声音身份与交付参数。
// INTENT: 它曾作为「Advanced」区块嵌在单个角色的声音页里：在一个角色页上点保存，就改到所有
//         没有自定义声音的角色。平台级设置只出现在平台配置页，角色页只留一行跳转。
// INVARIANT: 只用 manifest 已有的三个 operation（GET / PUT voice-defaults、POST preview），
//            写入门控是 generation.config.write；PUT 带 expectedVersion，并发改动由服务端拒绝。
import type {
  FishAudioDeliverySettings,
  SystemVoiceCatalogVoiceId,
  VoiceDefaultSettings,
} from "@idream/shared/admin";
import { Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useToast } from "@/components/admin/ui/Toast";
import { StatusBadge, WorkspaceButton } from "@/features/operations/WorkspaceUi";
import {
  VoiceDefaultSelect,
  VoiceDeliveryEditor,
  VoiceDeliverySummary,
  voiceProviderLabel,
} from "@/features/voice/VoiceSettingsControls";
import { useWorkspaceRefresh } from "@/features/workspace-refresh";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { useAuthorityResource } from "@/lib/authority-resource";

type VoiceDefaultDraft = Pick<VoiceDefaultSettings,
  "settingVersion" | "provider" | "defaultVoiceId" | "genderVoiceIds" | "delivery" | "catalog">;

const GENDER_FIELDS = [
  ["female", "Female character default"],
  ["male", "Male character default"],
  ["trans", "Trans character default"],
] as const;

export type PlatformVoiceDefaultsPermissions = {
  readonly read: boolean;
  readonly write: boolean;
  readonly preview: boolean;
};

export function PlatformVoiceDefaultsCard({ permissions }: { permissions: PlatformVoiceDefaultsPermissions }) {
  const { t, locale } = useAdminI18n();
  const { toast } = useToast();
  const resource = useAuthorityResource({
    key: "voice-defaults",
    enabled: permissions.read,
    load: useCallback(() => adminV2Operation("GET /api/v2/admin/voice-defaults", {}), []),
  });
  useWorkspaceRefresh(resource.refresh, permissions.read);
  const settings = resource.data;
  const [draftOverride, setDraftOverride] = useState<VoiceDefaultDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState<SystemVoiceCatalogVoiceId | null>(null);
  const [preview, setPreview] = useState<{ voiceId: SystemVoiceCatalogVoiceId; src: string; signature: string } | null>(null);
  const [previewError, setPreviewError] = useState<{ signature: string; text: string } | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  // An open confirmation must follow a permission revoked after it opened.
  const canWriteRef = useRef(permissions.write);
  useEffect(() => { canWriteRef.current = permissions.write; }, [permissions.write]);

  if (!permissions.read) {
    return (
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 text-sm" data-testid="platform-voice-defaults">
        <PermissionNotice permission="generation.config.read" />
      </section>
    );
  }
  if (!settings) {
    return (
      <section className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 text-sm" data-testid="platform-voice-defaults">
        {resource.error ? (
          <AuthorityRequestError cause={resource.cause} message={resource.error} onRetry={() => void resource.refresh()} requestKind="read" />
        ) : (
          <p role="status" className="text-[var(--ad-text-muted)]">{t("Loading system voice defaults…")}</p>
        )}
      </section>
    );
  }

  const draft: VoiceDefaultDraft = draftOverride ?? settings;
  // A draft built on an older version can never be saved: the authority refuses it.
  const stale = draft.provider !== settings.provider || draft.settingVersion !== settings.settingVersion;
  const editable = permissions.write && !busy && !stale;
  const dirty = draftOverride !== null && !stale && JSON.stringify(draftDiffKey(draftOverride)) !== JSON.stringify(draftDiffKey(settings));
  const previewSignature = (voiceId: string, delivery: FishAudioDeliverySettings) =>
    JSON.stringify([settings.provider, settings.settingVersion, voiceId, delivery]);
  const catalogLabel = (voiceId: string) => draft.catalog.find((entry) => entry.id === voiceId)?.label ?? voiceId;

  async function previewVoice(voiceId: SystemVoiceCatalogVoiceId) {
    if (!permissions.preview || previewBusy || busy || stale || !settings) return;
    const signature = previewSignature(voiceId, draft.delivery);
    setPreviewBusy(voiceId);
    setPreviewError(null);
    try {
      const response = await adminV2Operation("POST /api/v2/admin/voice-defaults/preview", {
        body: {
          provider: settings.provider,
          voiceId,
          text: settings.provider !== "pocket_tts" && locale === "zh"
            ? "靠近一点。这是系统默认声音的试听。"
            : "Come a little closer. This is the system default voice preview.",
          delivery: draft.delivery,
        },
      });
      setPreview({ voiceId, signature, src: `data:${response.contentType};base64,${response.audioBase64}` });
    } catch (cause) {
      setPreviewError({ signature, text: cause instanceof Error ? cause.message : "The system voice preview could not be rendered" });
    } finally {
      setPreviewBusy(null);
    }
  }

  function confirmSave() {
    if (!editable || !dirty) return;
    const saved = draft;
    setConfirmation({
      title: "Save system voice defaults",
      summary: (
        <div className="space-y-2">
          <p>{t("Provider")}: {voiceProviderLabel(saved.provider)} · {t("Settings version")}: {saved.settingVersion}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            {([["System fallback identity", saved.defaultVoiceId], ...GENDER_FIELDS.map(([gender, label]) => [label, saved.genderVoiceIds[gender]] as const)] as const).map(([label, voiceId]) => (
              <div className="contents" key={label}>
                <dt>{t(label)}</dt>
                <dd className="font-semibold">{t(catalogLabel(voiceId))}</dd>
              </div>
            ))}
          </dl>
          {saved.provider === "fish_audio" ? <VoiceDeliverySummary delivery={saved.delivery} t={t} /> : null}
          <p>{t("This is a platform-wide setting. It changes new speech for every character that has no voice override.")}</p>
          <p>{t("Characters with an activated voice keep it. Already generated audio is not replaced.")}</p>
        </div>
      ),
      consequence: {
        effect: t("New conversations of every inheriting character use the saved mapping right away. It does not go through a Character Release."),
        reversible: true,
      },
      requireReason: false,
      submitLabel: "Save system defaults",
      onSubmit: async () => {
        if (!canWriteRef.current) throw new Error(t("You no longer have permission to change system voice defaults."));
        setBusy(true);
        try {
          const result = await adminV2Operation("PUT /api/v2/admin/voice-defaults", {
            body: {
              expectedVersion: saved.settingVersion,
              provider: saved.provider,
              defaultVoiceId: saved.defaultVoiceId,
              genderVoiceIds: saved.genderVoiceIds,
              delivery: saved.delivery,
            },
          });
          setDraftOverride(null);
          setConfirmation(null);
          toast({
            tone: "success",
            title: t(result.replayed
              ? "The saved system voice defaults were recovered."
              : "System voice defaults were saved. New speech now uses this mapping."),
          });
          await resource.refresh();
        } finally {
          setBusy(false);
        }
      },
    });
  }

  return (
    <section
      aria-labelledby="platform-voice-defaults-title"
      className="space-y-5 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-5"
      data-testid="platform-voice-defaults"
    >
      <div>
        <h2 className="text-lg font-semibold" id="platform-voice-defaults-title">{t("System voice defaults")}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--ad-text-muted)]">
          {t("Every character without its own voice inherits these voices. A saved change applies to new conversations right away and does not go through a Character Release.")}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusBadge tone="warn" value={t("Affects all characters")} />
          <StatusBadge value={settings.source === "app_setting" ? t("saved in Admin") : t("environment fallback")} />
          <StatusBadge value={`${t("version")} ${settings.settingVersion}`} />
          <StatusBadge value={voiceProviderLabel(settings.provider)} />
        </div>
      </div>
      {!permissions.write ? <p className="text-xs"><PermissionNotice permission="generation.config.write" /></p> : null}
      <div className="grid gap-5 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <div className="space-y-3">
          <p className="text-xs leading-5 text-[var(--ad-text-muted)]">{t("Gender mappings select inherited voices. The fallback is used for other or unspecified genders.")}</p>
          <VoiceDefaultSelect
            active={false}
            busy={previewBusy}
            canPreview={permissions.preview && !busy && !stale}
            catalog={draft.catalog}
            disabled={!editable}
            inputId="system-voice-default-global"
            label={t("System fallback identity")}
            onChange={(defaultVoiceId) => setDraftOverride({ ...draft, defaultVoiceId })}
            onPreview={previewVoice}
            t={t}
            value={draft.defaultVoiceId}
          />
          {GENDER_FIELDS.map(([gender, label]) => (
            <VoiceDefaultSelect
              active={false}
              busy={previewBusy}
              canPreview={permissions.preview && !busy && !stale}
              catalog={draft.catalog}
              disabled={!editable}
              inputId={`system-voice-default-${gender}`}
              key={gender}
              label={t(label)}
              onChange={(voiceId) => setDraftOverride({ ...draft, genderVoiceIds: { ...draft.genderVoiceIds, [gender]: voiceId } })}
              onPreview={previewVoice}
              t={t}
              value={draft.genderVoiceIds[gender]}
            />
          ))}
        </div>
        <div className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-4">
          <div className="mb-4">
            <h3 className="text-sm font-semibold">{t("System performance direction")}</h3>
            {draft.provider === "fish_audio" ? (
              <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">{t("Set the sensual character of every inherited voice. Identity and performance stay separate.")}</p>
            ) : null}
          </div>
          {draft.provider === "pocket_tts" ? (
            <p className="text-sm leading-6 text-[var(--ad-text-muted)]">
              {t("Pocket TTS uses each official voice's native English delivery; performance controls are not applied.")}
            </p>
          ) : (
            // The runtime model is a per-Character projection; the IndexTTS note stays on the Character voice page.
            <VoiceDeliveryEditor delivery={draft.delivery} disabled={!editable} onChange={(delivery) => setDraftOverride({ ...draft, delivery })} t={t} />
          )}
        </div>
      </div>
      {preview && preview.signature === previewSignature(preview.voiceId, draft.delivery) ? (
        <div className="grid gap-3 rounded-lg bg-[var(--ad-blue-bg)] p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-sm font-semibold text-[var(--ad-blue-text)]">{t("Previewing {voice}", { voice: t(catalogLabel(preview.voiceId)) })}</p>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("Listen before saving the default mapping.")}</p>
          </div>
          <audio aria-label={t("System voice preview")} autoPlay className="w-full sm:w-72" controls src={preview.src} />
        </div>
      ) : null}
      {previewError ? <p className="rounded-lg bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">{t(previewError.text)}</p> : null}
      {stale ? (
        <div className="space-y-3 rounded-lg bg-[var(--ad-yellow-bg)] p-4 text-sm" role="alert">
          <p>{t("System defaults changed while you were editing. Your draft is preserved; load the current defaults before editing again.")}</p>
          <WorkspaceButton disabled={busy} onClick={() => setDraftOverride(null)} type="button">
            {t("Discard draft and load current defaults")}
          </WorkspaceButton>
        </div>
      ) : null}
      <div className="border-t border-[var(--ad-border)] pt-4">
        <WorkspaceButton disabled={!editable || !dirty} onClick={confirmSave} tone="primary" type="button">
          <Save aria-hidden="true" className="h-4 w-4" />
          {busy ? t("Saving defaults…") : t("Save system defaults")}
        </WorkspaceButton>
      </div>
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

function draftDiffKey(draft: VoiceDefaultDraft) {
  return [draft.defaultVoiceId, draft.genderVoiceIds, draft.delivery];
}
