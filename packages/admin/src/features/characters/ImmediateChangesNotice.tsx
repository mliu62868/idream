"use client";

// SPEC: 发布页上的只读小区块 —— 说出哪些改动不随发布、立即生效，以及当前线上的声音。
// INTENT: 运营在发布页的心智是「这里决定线上用什么」。声音激活 / 重置、聊天素材「Use in chat」
//         却绕过 Release 直接改线上，发布页以前对它们只字不提。这里不提供任何写操作，只给去处。
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { AudioLines, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useAdminI18n } from "@/components/admin/i18n";
import { voiceProviderLabel } from "@/features/voice/VoiceSettingsControls";
import {
  CHARACTER_IMMEDIATE_EFFECT_COPY,
  PLATFORM_VOICE_DEFAULTS_HREF,
  characterWorkspaceTabHref,
} from "./character-immediate-effects";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function characterLiveVoiceName(voice: CharacterWorkspaceDetail["voice"], t: Translate) {
  const label = (voiceId: string) =>
    voice.systemDefaults.catalog.find((entry) => entry.id === voiceId)?.label ??
    voiceId.charAt(0).toUpperCase() + voiceId.slice(1).replaceAll("_", " ");
  const active = voice.activeProfile;
  if (active) return active.presetVoiceId ? label(active.presetVoiceId) : t("Cloned voice");
  return label(voice.effectiveVoiceId);
}

export function ImmediateChangesNotice({ data }: { data: CharacterWorkspaceDetail }) {
  const { t } = useAdminI18n();
  const voice = data.voice;
  const liveProvider = voice.activeProfile?.provider ?? voice.systemDefaults.provider;
  const linkClass = "font-semibold text-[var(--ad-ink)] underline";
  return (
    <section
      aria-labelledby="immediate-changes-title"
      className="rounded-lg border border-[var(--ad-yellow-text)]/30 bg-[var(--ad-yellow-bg)]/40 p-4 text-sm"
      data-testid="immediate-changes-notice"
    >
      <h3 className="font-semibold" id="immediate-changes-title">{t("Live without a Release")}</h3>
      <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
        {t("Publishing does not include these changes. They are already live: {effect}", { effect: t(CHARACTER_IMMEDIATE_EFFECT_COPY) })}
      </p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {/* INVARIANT: dl > div 里只能直接放 dt / dd（WCAG definition-list），图标放进 dt。 */}
        <div className="min-w-0">
          <dt className="flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
            <AudioLines aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t("Current live voice")}
          </dt>
          <dd className="mt-0.5 pl-6">
            <strong className="font-semibold" data-testid="immediate-changes-live-voice">{characterLiveVoiceName(voice, t)}</strong>
            <span className="text-[var(--ad-text-muted)]">
              {" · "}{voiceProviderLabel(liveProvider, voice.activeProfile?.model ?? (liveProvider === voice.provider ? voice.runtimeModel : null))}
              {" · "}{voice.authoritySource === "character_clone" ? t("Character override") : t("System inheritance")}
            </span>
            <span className="mt-1 block text-xs text-[var(--ad-text-muted)]">
              {t("Activating a voice or switching back to the system default changes it right away.")}{" "}
              <Link className={linkClass} href={characterWorkspaceTabHref(data.character.id, "voice")}>{t("Open Voice")}</Link>
              {voice.authoritySource === "system_default" ? (
                <>
                  {" · "}
                  <Link className={linkClass} href={PLATFORM_VOICE_DEFAULTS_HREF}>{t("Open system voice defaults")}</Link>
                </>
              ) : null}
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
            <MessageCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t("Chat media")}
          </dt>
          <dd className="mt-0.5 pl-6">
            {t("Use in chat and Withdraw from chat change what live chats can send right away.")}
            <span className="mt-1 block text-xs">
              <Link className={linkClass} href={characterWorkspaceTabHref(data.character.id, "assets")}>{t("Open image chat media")}</Link>
              {" · "}
              <Link className={linkClass} href={characterWorkspaceTabHref(data.character.id, "video")}>{t("Open video chat media")}</Link>
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
