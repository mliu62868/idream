"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { ArrowRight, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { withCharacterRoster } from "./portfolio-query";
import { CharacterPortfolioVisual } from "./CharacterPortfolioVisual";
import { characterPrimaryActionCopy } from "./character-primary-action-copy";
import { characterLifecycleLabel } from "./character-lifecycle-copy";

// SPEC: 线上/暂停/退役要分得清。暂停的角色线上没有人看得到，不能继续写 Live。
export function characterReleasePackLabel(servingState: string) {
  if (servingState === "paused") return "Paused {completed}/{total}";
  if (servingState === "retired") return "Retired {completed}/{total}";
  return "Live {completed}/{total}";
}

export function characterPortfolioState(item: CharacterPortfolioItem) {
  // Lifecycle is authoritative even while a production journey still has work.
  if (item.serving.state === "retired" || item.serving.state === "paused") {
    return {
      badge: "bg-[var(--ad-surface-subtle)] text-[var(--ad-text-muted)]",
      label: characterLifecycleLabel(item.serving),
      tone: "text-[var(--ad-text-muted)]",
    } as const;
  }
  if (
    item.serving.state === "live" ||
    item.journey.stage === "live_operations"
  ) {
    return {
      badge: "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
      label: "Live",
      tone: "text-[var(--ad-green-text)]",
    } as const;
  }
  if (item.journey.stage === "image_production") {
    return {
      badge: "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
      label: "Making images",
      tone: "text-[var(--ad-blue-text)]",
    } as const;
  }
  if (item.journey.blockers.some(({ code }) => code === "opening_complete" || code === "soul_snapshot_valid" || code === "soul_release_policy")) {
    return {
      badge: "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
      label: "Persona needs repair",
      tone: "text-[var(--ad-yellow-text)]",
    } as const;
  }
  if (item.journey.stage === "preview") {
    return {
      badge: "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
      label: "Ready for preview",
      tone: "text-[var(--ad-blue-text)]",
    } as const;
  }
  if (item.journey.stage === "publishing") {
    return {
      badge: "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
      label: "Ready to publish",
      tone: "text-[var(--ad-yellow-text)]",
    } as const;
  }
  return {
    badge: "bg-[var(--ad-surface-subtle)] text-[var(--ad-text-muted)]",
    label: "Draft",
    tone: "text-[var(--ad-text-muted)]",
  } as const;
}

export function CharacterPortfolioCard({
  canOpenAssets,
  canOpenProject,
  eager = false,
  item,
  onQuickToggleServing,
  onToggleSelected,
  quickBusy = false,
  rosterQuery,
  selected = false,
}: {
  canOpenAssets: boolean;
  canOpenProject: boolean;
  eager?: boolean;
  item: CharacterPortfolioItem;
  onQuickToggleServing?: () => void;
  onToggleSelected?: () => void;
  quickBusy?: boolean;
  rosterQuery?: string;
  selected?: boolean;
}) {
  const { t } = useAdminI18n();
  const primaryAction = item.journey.primaryAction;
  const actionCopy = characterPrimaryActionCopy[primaryAction.code];
  const state = characterPortfolioState(item);
  const { assetPack } = item.journey;
  const characterHref = `/admin/characters/${encodeURIComponent(item.characterId)}`;
  const identity = (
    <>
      <CharacterPortfolioVisual
        canOpenAssets={canOpenAssets}
        eager={eager}
        linkToAssets={false}
        name={item.name}
        variant="tile"
        visualProduction={item.visualProduction}
      />
      <div className="p-4 pb-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h3
            className="min-w-0 break-words text-base font-semibold text-[var(--ad-ink)]"
            title={item.name}
          >
            {item.name}
          </h3>
          <span
            className={cn(
              "shrink-0 rounded-md px-2 py-1 text-xs font-semibold",
              state.badge,
            )}
          >
            {t(state.label)}
          </span>
        </div>
        <p className="mt-3 flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
          <ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />
          <span>
            {[
              t("Draft {completed}/{total}", {
                completed: assetPack.draft.completed,
                total: assetPack.draft.total,
              }),
              t(characterReleasePackLabel(item.serving.state), {
                completed: assetPack.live.completed,
                total: assetPack.live.total,
              }),
            ].join(" · ")}
          </span>
        </p>
      </div>
    </>
  );

  // SPEC: 卡片分成两个点击区——图片与名字进角色主页，下半区的动作直达它自己的 tab。
  // INTENT: 整张卡片曾是一个 <Link>，任何深链都只能是嵌套 <a>（非法 HTML）。要把 journey
  //         的下一步动作放上来，就必须先把外层链接收窄到"这是谁"那一块。
  return (
    <article
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-[var(--ad-surface)] transition-[border-color,transform] hover:-translate-y-0.5 hover:border-black/25",
        selected ? "border-[var(--ad-ink)]" : "border-[var(--ad-border)]",
      )}
      data-layout="roster"
    >
      {onToggleSelected ? (
        <label className="absolute left-2 top-2 z-10 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md bg-[var(--ad-surface)]/90">
          <input
            aria-label={t("Select {name}", { name: item.name })}
            checked={selected}
            className="h-4 w-4"
            onChange={onToggleSelected}
            type="checkbox"
          />
        </label>
      ) : null}
      {canOpenProject ? (
        <Link
          aria-label={t("Open {name}", { name: item.name })}
          className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--ad-ink)]"
          href={withCharacterRoster(characterHref, rosterQuery)}
        >
          {identity}
        </Link>
      ) : (
        identity
      )}
      <div className="mt-auto border-t border-[var(--ad-border)] px-4 py-3 text-xs">
        {item.journey.status === "blocked" ? (
          <p className="mb-1 leading-snug text-[var(--ad-text-muted)]">{t(actionCopy.eyebrow)}</p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          {primaryAction.canReadTarget ? (
            <Link
              className="flex min-h-8 min-w-0 flex-1 items-center justify-between gap-2 text-sm font-semibold text-[var(--ad-ink)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
              href={withCharacterRoster(primaryAction.deepLink, rosterQuery)}
            >
              <span className="truncate">{t(actionCopy.label)}</span>
              <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            </Link>
          ) : (
            <p className="flex min-h-8 min-w-0 flex-1 items-center text-sm font-semibold text-[var(--ad-ink)]">
              <span className="truncate">{t(actionCopy.label)}</span>
            </p>
          )}
          {onQuickToggleServing && (item.serving.state === "live" || item.serving.state === "paused") ? (
            <button
              className="min-h-8 shrink-0 rounded-md border border-[var(--ad-border)] px-2.5 text-xs font-semibold text-[var(--ad-ink)] hover:bg-black/[0.03] disabled:opacity-40"
              disabled={quickBusy || item.journey.hasActiveCommand}
              onClick={onQuickToggleServing}
              type="button"
            >
              {t(item.serving.state === "paused" ? "Resume" : "Pause")}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
