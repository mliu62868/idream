"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { INDEXTTS_VOICE_MODEL_ID } from "@idream/shared/contracts";
import { Settings2 } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { PLATFORM_VOICE_DEFAULTS_HREF } from "./character-immediate-effects";

// SPEC: 全平台默认声音只在平台配置页编辑；角色页只说明「继承系统默认」并给出去处。
// INTENT: 它曾作为「Advanced」区块嵌在角色声音面板里，在一个角色页上点保存就改到所有
//         没有自定义声音的角色。
export function CharacterVoiceSystemDefaultsNote({ voice }: { voice: CharacterWorkspaceDetail["voice"] }) {
  const { t } = useAdminI18n();
  return (
    <section
      aria-labelledby="system-voice-defaults-title"
      className="flex flex-col gap-2 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6"
      data-testid="system-voice-defaults"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Settings2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ad-text-muted)]" />
        <div className="min-w-0">
          <h3 className="font-semibold" id="system-voice-defaults-title">
            {voice.authoritySource === "system_default"
              ? t("Uses the system default voice")
              : t("Characters without their own voice use the system default voice")}
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t("System default voices apply to every character and are managed on the platform configuration page, not here.")}
            {voice.runtimeModel === INDEXTTS_VOICE_MODEL_ID && voice.systemDefaults.provider === "fish_audio"
              ? ` ${t("IndexTTS uses fixed sampling. Saved advanced settings are retained for other models.")}`
              : ""}
          </p>
        </div>
      </div>
      <a
        className="shrink-0 text-sm font-semibold text-[var(--ad-ink)] underline"
        href={PLATFORM_VOICE_DEFAULTS_HREF}
      >
        {t("Open system voice defaults")}
      </a>
    </section>
  );
}
