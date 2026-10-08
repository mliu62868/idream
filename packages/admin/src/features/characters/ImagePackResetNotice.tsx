"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";

// Pack completeness comes from the server journey, never from counting preview slots
// here (deep-module-authority-boundaries).
export function draftSelectedImageCount(data: Pick<CharacterWorkspaceDetail, "journey">) {
  return data.journey.assetPack.draft.completed;
}

// SPEC: shown beside every write that replaces the visual identity or its references.
// INTENT: the server clears the draft cover/hero/chat selections on those writes so the
// character stays one person (invalidateCharacterDraftAssetPack). The rule is right, but
// operators only learned about it after losing several minutes of chosen images.
export function ImagePackResetNotice({ count }: { count: number }) {
  const { t } = useAdminI18n();
  if (count === 0) return null;
  return (
    <p className="mt-3 rounded-md bg-[var(--ad-yellow-bg)] px-3 py-2 text-xs leading-5 text-[var(--ad-yellow-text)]" role="note">
      {t("This clears the {count} cover, hero, and chat images already chosen for the draft. Choose them again afterwards. The live character is not affected.", { count: String(count) })}
    </p>
  );
}
