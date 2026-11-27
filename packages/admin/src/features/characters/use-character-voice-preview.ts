import type { CharacterWorkspaceDetail, SystemVoiceCatalogVoiceId } from "@idream/shared/admin";
import { useState } from "react";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import {
  livePreviewScript,
  voicePreviewRequestBody,
  voicePreviewSignature,
  type VoicePreviewScope,
} from "./character-voice-model";

export type CatalogVoicePreview = {
  voiceId: SystemVoiceCatalogVoiceId;
  src: string;
  scope: VoicePreviewScope;
  signature: string;
};

export type CatalogVoicePreviewError = {
  scope: VoicePreviewScope;
  voiceId: SystemVoiceCatalogVoiceId;
  signature: string;
  text: string;
};

// SPEC: 系统目录声音的试听（当前线上声音 + 官方声音试听）。一次只渲染一条；
// 每条结果都带签名，界面只展示与当前选择、脚本、系统设置版本一致的那条。
export function useCharacterVoicePreview({
  data,
  locale,
  canPreview,
  busy,
  auditionText,
}: {
  data: CharacterWorkspaceDetail;
  locale: string;
  canPreview: boolean;
  busy: boolean;
  auditionText: string;
}) {
  const voice = data.voice;
  const [previewBusy, setPreviewBusy] = useState<SystemVoiceCatalogVoiceId | null>(null);
  const [catalogPreview, setCatalogPreview] = useState<CatalogVoicePreview | null>(null);
  const [error, setError] = useState<CatalogVoicePreviewError | null>(null);

  async function previewCatalogVoice(
    voiceId: SystemVoiceCatalogVoiceId,
    scope: VoicePreviewScope,
  ) {
    if (!canPreview || previewBusy || busy) return;
    const delivery = voice.systemDefaults.delivery;
    const text = scope === "audition"
      ? auditionText
      : livePreviewScript(voice.systemDefaults.provider, locale, data.character.name);
    if (text.length < 3) return;
    const signature = voicePreviewSignature(
      data.character.id,
      voice,
      voiceId,
      delivery,
      scope === "audition" ? text : scope,
    );
    setPreviewBusy(voiceId);
    setError(null);
    try {
      const preview = await adminV2Operation("POST /api/v2/admin/voice-defaults/preview", {
        body: voicePreviewRequestBody({
          scope,
          provider: voice.systemDefaults.provider,
          voiceId,
          text,
          delivery,
        }),
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
        voiceId,
        signature,
        text: cause instanceof Error ? cause.message : "The system voice preview could not be rendered",
      });
    } finally {
      setPreviewBusy(null);
    }
  }

  return { previewBusy, catalogPreview, error, previewCatalogVoice };
}
