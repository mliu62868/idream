"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { WorkspaceButton } from "@/features/operations/WorkspaceUi";
import type { CharacterPortfolioEmptyView } from "./portfolio-query";

export function CharacterListEmptyState({
  onClear,
  view,
}: {
  onClear: () => void;
  view: CharacterPortfolioEmptyView;
}) {
  const { t } = useAdminI18n();
  const filtered = view !== "all";
  return (
    <section className="rounded-xl bg-[var(--ad-surface)] px-6 py-14 text-center">
      <h3 className="text-base font-semibold">
        {view === "attention"
          ? t("No character needs attention right now")
          : view === "live_asset_pack_incomplete"
            ? t("Every live image pack is complete")
            : view === "filtered"
            ? t("No characters match these filters")
            : t("No characters yet")}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--ad-text-muted)]">
        {view === "attention"
          ? t(
              "Every eligible live character has exposure or funnel observations.",
            )
          : view === "live_asset_pack_incomplete"
            ? t("No live Character is missing a required image placement.")
            : view === "filtered"
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
