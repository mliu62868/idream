"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { History } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";
import { StatusBadge } from "@/features/operations/WorkspaceUi";
import { voiceProviderLabel } from "@/features/voice/VoiceSettingsControls";
import { archivedVoiceProfiles, voiceProfileName } from "./character-voice-model";

// SPEC: 二级信息：已退役的声音版本（不含当前线上与待审候选），默认折叠。
export function CharacterVoiceProfileHistory({ data }: { data: CharacterWorkspaceDetail }) {
  const { t, locale } = useAdminI18n();
  const archivedProfiles = archivedVoiceProfiles(data.voice);
  if (archivedProfiles.length === 0) return null;
  return (
    <details className="overflow-hidden rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 sm:px-6">
        <span className="inline-flex items-center gap-2 text-sm font-semibold">
          <History aria-hidden="true" className="h-4 w-4 text-[var(--ad-text-muted)]" />
          {t("Voice history")}
        </span>
        <StatusBadge value={`${archivedProfiles.length}`} />
      </summary>
      <ul className="divide-y divide-[var(--ad-border)] border-t border-[var(--ad-border)]">
        {archivedProfiles.map((profile) => (
          <li className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm sm:px-6" key={profile.id}>
            <span className="min-w-0">
              <strong className="font-semibold">{voiceProfileName(data.voice, profile, t)}</strong>
              <span className="text-[var(--ad-text-muted)]">
                {" "}· {voiceProviderLabel(profile.provider, profile.model)} · v{profile.version} ·{" "}
                {new Date(profile.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}
              </span>
            </span>
            <StatusBadge value={profile.status} />
          </li>
        ))}
      </ul>
    </details>
  );
}
