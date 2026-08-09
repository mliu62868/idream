"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";

export function CharacterListEmptyState({
  filtered,
  attentionOnly = false,
  onClear,
}: {
  filtered: boolean;
  attentionOnly?: boolean;
  onClear: () => void;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-xl bg-[var(--ad-surface)] px-6 py-14 text-center">
      <h3 className="text-base font-semibold">
        {attentionOnly
          ? t("No character needs attention right now")
          : filtered
            ? t("No characters match these filters")
            : t("No characters yet")}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--ad-text-muted)]">
        {attentionOnly
          ? t(
              "Every live character has a complete image pack and is recording observations.",
            )
          : filtered
            ? t("Clear filters to return to all characters.")
            : t("No characters are available yet.")}
      </p>
      {filtered ? (
        <div className="mt-5">
          <WorkspaceButton onClick={onClear}>
            {t("Clear filters")}
          </WorkspaceButton>
        </div>
      ) : null}
    </section>
  );
}
