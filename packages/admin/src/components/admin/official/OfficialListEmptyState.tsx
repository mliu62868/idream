"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import { Plus } from "lucide-react";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { GhostButton, PrimaryButton } from "@/components/admin/ui/buttons";

export function OfficialListEmptyState({
  filtered,
  onClear,
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  const { t } = useAdminI18n();
  if (filtered) {
    return (
      <EmptyState
        action={<GhostButton onClick={onClear}>{t("Clear filters")}</GhostButton>}
        hint="Clear the URL-backed search and filters to return to the full portfolio."
        title={t("No character projects match these filters.")}
      />
    );
  }

  return (
    <EmptyState
      action={(
        <Link href="/admin/content/official/new">
          <PrimaryButton><Plus className="h-4 w-4" />  {t("New character project")}</PrimaryButton>
        </Link>
      )}
      hint="Create a private draft, then complete its persona, visual identity, artwork, and preview."
      title={t("No character projects exist yet.")}
    />
  );
}
