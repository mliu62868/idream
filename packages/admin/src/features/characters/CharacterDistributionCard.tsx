"use client";

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useEffect, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { CharacterFeaturedToggle } from "@/features/content-merchandising/CharacterFeaturedToggle";
import { StatusBadge } from "@/features/operations/WorkspaceUi";
import { adminV2Operation, type AdminV2OperationResponse } from "@/lib/admin-v2-operation";
import { useCharacterWorkspaceActions } from "./character-workspace-actions";

type Placement = AdminV2OperationResponse<"GET /api/v2/admin/content/placements">["items"][number];

// SPEC: 这个角色出现在哪些分发位：精选与展示位。精选可就地一键加入 / 移出。
export function CharacterDistributionCard({ data }: { readonly data: CharacterWorkspaceDetail }) {
  const { t } = useAdminI18n();
  const actions = useCharacterWorkspaceActions();
  const canReadPlacements = actions?.permissions.readPlacements ?? false;
  const characterId = data.character.id;
  const [placements, setPlacements] = useState<{ readonly items: readonly Placement[] } | { readonly error: string } | null>(null);

  useEffect(() => {
    if (!canReadPlacements) return;
    let current = true;
    adminV2Operation("GET /api/v2/admin/content/placements", {
      query: new URLSearchParams({ targetId: characterId }),
    }).then(
      (result) => { if (current) setPlacements({ items: result.items }); },
      (cause: unknown) => {
        if (current) setPlacements({ error: cause instanceof Error ? cause.message : "Placements could not be loaded" });
      },
    );
    return () => { current = false; };
  }, [canReadPlacements, characterId]);

  // INVARIANT: 读精选需要 content.read；没有就不发必定被拒的请求。
  if (!actions?.permissions.readContent) return null;
  return (
    <section className="border-b border-[var(--ad-border)] pb-6" data-testid="character-distribution-card">
      <h3 className="text-sm font-semibold">{t("Distribution")}</h3>
      <div className="mt-3">
        <CharacterFeaturedToggle
          canWrite={actions.permissions.manageFeatured}
          characterId={characterId}
        />
      </div>
      {canReadPlacements ? (
        <div className="mt-3 text-sm">
          <p className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Linked placements")}</p>
          {placements === null ? (
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]" role="status">{t("Loading…")}</p>
          ) : "error" in placements ? (
            <p className="mt-1 text-xs text-[var(--ad-red-text)]" role="alert">{t(placements.error)}</p>
          ) : placements.items.length === 0 ? (
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t("No placements link to this Character")}</p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-2">
              {placements.items.map((placement) => (
                <li className="flex items-center gap-2 text-xs" key={placement.id}>
                  <span>{t(placement.slot.replaceAll("_", " "))}</span>
                  <StatusBadge value={placement.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
