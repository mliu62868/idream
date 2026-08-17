"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { ArrowRight } from "lucide-react";
import { useAdminFormat } from "@/components/admin/ui/format";
import { StatusBadge } from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";
import { percent } from "./character-workspace-format";
import { CharacterPortfolioVisual } from "./CharacterPortfolioVisual";

// SPEC: 取 t 作为入参而不是自己调 hook —— 它被 CharacterPortfolioCard.test.ts 当纯函数测。
// INTENT: 原实现直接返回英文串渲染进 JSX，是这个域里最后一处绕过 i18n 的动态文案。
export function characterPortfolioPerformanceLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  performance: Pick<
    CharacterPortfolioItem["performance"][number],
    "maturity" | "qceRate" | "sameCharacterD7"
  > | null,
) {
  const metrics = !performance
    ? []
    : [
        performance.qceRate === null
          ? null
          : t("28d QCE {value}", { value: percent(performance.qceRate) }),
        performance.sameCharacterD7 === null
          ? null
          : t("D7 {value}", { value: percent(performance.sameCharacterD7) }),
      ].filter((metric): metric is string => metric !== null);
  if (!performance || metrics.length === 0) {
    return t("28d performance will appear after sufficient live traffic.");
  }
  return t("{metrics} · {maturity}", {
    maturity: t(performance.maturity.replaceAll("_", " ")),
    metrics: metrics.join(" · "),
  });
}

type CharacterPortfolioPrimaryAction = {
  readonly description: string;
  readonly eyebrow: string;
  readonly href: string;
  readonly label: string;
  readonly requiresAssets: boolean;
};

const characterPortfolioPrimaryActionCopy: Record<
  CharacterPortfolioItem["journey"]["primaryAction"]["code"],
  Omit<CharacterPortfolioPrimaryAction, "href">
> = {
  recover_active_command: {
    description:
      "Finish or reconcile the command that currently owns this Character.",
    eyebrow: "Mutation in progress",
    label: "Open active command",
    requiresAssets: false,
  },
  create_primary_portrait: {
    description:
      "Start here: lock the face once, then reuse it for every new image.",
    eyebrow: "First-time setup",
    label: "Create first identity portrait",
    requiresAssets: true,
  },
  prepare_image_production: {
    description:
      "Use the existing live portrait once, then create future images without changing the live character.",
    eyebrow: "Enable image production",
    label: "Use existing portrait",
    requiresAssets: true,
  },
  complete_image_route: {
    description:
      "The identity portrait is locked. Activate a compatible image route before creating an image.",
    eyebrow: "Image route setup",
    label: "Complete image route setup",
    requiresAssets: false,
  },
  continue_image_run: {
    description: "Return to the latest unfinished image without starting over.",
    eyebrow: "Image in progress",
    label: "Continue current image",
    requiresAssets: true,
  },
  continue_asset_pack: {
    description: "Complete the portrait, hero, and chat image set.",
    eyebrow: "Image pack in progress",
    label: "Continue filling image pack",
    requiresAssets: true,
  },
  run_preview_qa: {
    description: "Check the customer-facing draft before publishing.",
    eyebrow: "Ready for launch review",
    label: "Review launch preview",
    requiresAssets: false,
  },
  review_candidate_release: {
    description: "Confirm the candidate version and release evidence.",
    eyebrow: "Release in progress",
    label: "Continue release review",
    requiresAssets: false,
  },
  monitor_live_character: {
    description: "Open live monitoring and performance evidence.",
    eyebrow: "Live character",
    label: "Review live character",
    requiresAssets: false,
  },
};

export function resolveCharacterPortfolioPrimaryAction(
  item: CharacterPortfolioItem,
): CharacterPortfolioPrimaryAction {
  return {
    ...characterPortfolioPrimaryActionCopy[item.journey.primaryAction.code],
    href: item.journey.primaryAction.deepLink,
  };
}

export function characterPortfolioState(item: CharacterPortfolioItem) {
  if (
    item.serving.state === "live" ||
    item.journey.stage === "live_operations"
  ) {
    return { label: "Live", tone: "text-[var(--ad-green-text)]" } as const;
  }
  if (item.journey.stage === "image_production") {
    return {
      label: "In production",
      tone: "text-[var(--ad-blue-text)]",
    } as const;
  }
  if (item.journey.stage === "preview_qa") {
    return {
      label: "Ready for preview",
      tone: "text-[var(--ad-blue-text)]",
    } as const;
  }
  if (item.journey.stage === "release_review") {
    return {
      label: "Pending release",
      tone: "text-[var(--ad-yellow-text)]",
    } as const;
  }
  return { label: "Draft", tone: "text-[var(--ad-text-muted)]" } as const;
}

export function CharacterPortfolioCard({
  canOpenAssets,
  canOpenProject,
  eager = false,
  item,
  mode,
}: {
  canOpenAssets: boolean;
  canOpenProject: boolean;
  eager?: boolean;
  item: CharacterPortfolioItem;
  mode: "studio" | "performance";
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const performanceMode = mode === "performance";
  const performance =
    item.performance.find(
      (metric) => metric.window === "28d" && metric.placementId === null,
    ) ??
    item.performance.find((metric) => metric.window === "28d") ??
    null;
  const primaryAction = resolveCharacterPortfolioPrimaryAction(item);
  const canOpenNextAction =
    canOpenProject && (!primaryAction.requiresAssets || canOpenAssets);
  if (performanceMode) {
    return (
      <article className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors md:grid-cols-[96px_minmax(0,1fr)_minmax(220px,280px)]">
        <CharacterPortfolioVisual
          canOpenAssets={canOpenProject && canOpenAssets}
          eager={eager}
          name={item.name}
          visualProduction={item.visualProduction}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold text-[var(--ad-ink)]">
              {canOpenProject ? (
                <Link
                  className="hover:underline"
                  href={`/admin/characters/${encodeURIComponent(item.characterId)}`}
                >
                  {item.name}
                </Link>
              ) : (
                item.name
              )}
            </h3>
            <StatusBadge value={item.serving.state} />
            <StatusBadge value={item.readiness} />
          </div>
          <p className="mt-2 text-sm text-[var(--ad-text-muted)]">
            {t(item.project.audience)} ·{" "}
            {t(item.project.phase.replaceAll("_", " "))}
          </p>
          <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
            {characterPortfolioPerformanceLabel(t, performance)}
          </p>
        </div>
        <div className="self-center rounded-lg border border-[var(--ad-border)] bg-black/[0.02] p-3 text-left text-xs text-[var(--ad-text-muted)]">
          <p className="font-semibold uppercase tracking-[0.14em]">
            {t(primaryAction.eyebrow)}
          </p>
          {canOpenNextAction ? (
            <Link
              className="mt-1 inline-flex min-h-8 items-center gap-1.5 text-sm font-semibold text-[var(--ad-ink)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
              href={primaryAction.href}
            >
              {t(primaryAction.label)}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          ) : (
            <span className="mt-1 block font-semibold text-[var(--ad-ink)]">
              {t("Performance only")}
            </span>
          )}
          <p className="mt-1 leading-5">{t(primaryAction.description)}</p>
          {item.latestDecision ? (
            <span className="mt-2 block border-t border-[var(--ad-border)] pt-2">
              {t("Latest decision:")} {item.latestDecision.decision}
            </span>
          ) : null}
        </div>
      </article>
    );
  }

  const state = characterPortfolioState(item);
  const { assetPack, blockers } = item.journey;
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
      <div className="pt-3">
        <h3 className="truncate text-base font-semibold text-[var(--ad-ink)]">
          {item.name}
        </h3>
        <p className={cn("mt-1 text-sm", state.tone)}>{t(state.label)}</p>
      </div>
    </>
  );

  // SPEC: 卡片分成两个点击区——图片与名字进角色主页，下半区的动作直达它自己的 tab。
  // INTENT: 整张卡片曾是一个 <Link>，任何深链都只能是嵌套 <a>（非法 HTML）。要把 journey
  //         的下一步动作放上来，就必须先把外层链接收窄到"这是谁"那一块。
  return (
    <article className="flex flex-col" data-layout="roster">
      {canOpenProject ? (
        <Link
          aria-label={t("Open {name}", { name: item.name })}
          className="group block rounded-lg transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--ad-ink)]"
          href={characterHref}
        >
          {identity}
        </Link>
      ) : (
        identity
      )}
      <div className="mt-3 border-t border-[var(--ad-border)] pt-3 text-xs">
        <p className="font-semibold uppercase tracking-[0.14em] text-[var(--ad-text-muted)]">
          {t(primaryAction.eyebrow)}
        </p>
        {canOpenNextAction ? (
          <Link
            className="mt-1 inline-flex min-h-8 items-center gap-1.5 text-sm font-semibold text-[var(--ad-ink)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
            href={primaryAction.href}
          >
            {t(primaryAction.label)}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        ) : (
          <p className="mt-1 text-sm font-semibold text-[var(--ad-ink)]">
            {t(primaryAction.label)}
          </p>
        )}
        {blockers.length > 0 ? (
          <p className="mt-1 line-clamp-2 text-[var(--ad-red-text)]">
            {blockers.length > 1
              ? t("{message} · +{count} more", {
                  count: blockers.length - 1,
                  message: t(blockers[0].message),
                })
              : t(blockers[0].message)}
          </p>
        ) : null}
        <p className="mt-2 truncate text-[var(--ad-text-muted)]">
          {[
            item.project.ownerId ?? t("Unassigned"),
            t("Draft {completed}/{total}", {
              completed: assetPack.draft.completed,
              total: assetPack.draft.total,
            }),
            t("Live {completed}/{total}", {
              completed: assetPack.live.completed,
              total: assetPack.live.total,
            }),
            format.date(item.project.updatedAt),
          ].join(" · ")}
        </p>
      </div>
    </article>
  );
}
