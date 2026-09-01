"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { ArrowRight, ImageIcon } from "lucide-react";
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
  review_asset_pack: {
    description:
      "Review the selected portrait, hero, and chat images before publishing.",
    eyebrow: "Image review required",
    label: "Review selected images",
    requiresAssets: true,
  },
  preview_character: {
    description: "Preview the customer-facing draft before publishing.",
    eyebrow: "Ready to preview",
    label: "Preview Character",
    requiresAssets: false,
  },
  publish_character: {
    description: "Publish the prepared immutable Character snapshot.",
    eyebrow: "Ready to publish",
    label: "Publish Character",
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
  const journeyAction = {
    ...characterPortfolioPrimaryActionCopy[item.journey.primaryAction.code],
    href: item.journey.primaryAction.deepLink,
  };
  // SPEC: 卡片主动作只服从这个优先级：未完成命令/旅程阻塞 → Release 阻塞 → 线上零观测
  //       → 待发布版本 → 线上图片包缺失 → 普通制作旅程。
  // INTENT: 生成批次只是生产过程，不能盖过线上故障或发布决策。
  if (
    item.journey.primaryAction.code === "recover_active_command" ||
    item.journey.status === "blocked"
  ) {
    return journeyAction;
  }
  if (item.readiness === "blocked") {
    return {
      description:
        "Resolve the current live Release blocker before continuing routine production.",
      eyebrow: "Live release blocked",
      href:
        item.operationalState.blockers[0]?.deepLink ??
        `/admin/characters/${encodeURIComponent(item.characterId)}?tab=monitor`,
      label: "Resolve live release blocker",
      requiresAssets: false,
    };
  }
  if (item.needsAttention) {
    return {
      description:
        "This live Character has no exposure or funnel events after the 7-day observation window.",
      eyebrow: "No telemetry after 7 days",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=monitor`,
      label: "Inspect live monitoring",
      requiresAssets: false,
    };
  }
  if (item.journey.primaryAction.code === "publish_character") {
    return journeyAction;
  }
  if (
    item.serving.state === "live" &&
    item.journey.assetPack.live.completed < item.journey.assetPack.live.total
  ) {
    return {
      description: "Complete the portrait, hero, and chat image set.",
      eyebrow: "Live with an incomplete image pack",
      href: item.visualProduction.deepLink,
      label: "Complete image pack",
      requiresAssets: true,
    };
  }
  return journeyAction;
}

export function characterPortfolioState(item: CharacterPortfolioItem) {
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
      label: "In production",
      tone: "text-[var(--ad-blue-text)]",
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
  mode,
}: {
  canOpenAssets: boolean;
  canOpenProject: boolean;
  eager?: boolean;
  item: CharacterPortfolioItem;
  mode: "studio" | "performance";
}) {
  const { t } = useAdminI18n();
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
            <h3
              className="min-w-0 break-words font-semibold text-[var(--ad-ink)]"
              title={item.name}
            >
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
        </div>
      </article>
    );
  }

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
              t("Live {completed}/{total}", {
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
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] transition-[border-color,transform] hover:-translate-y-0.5 hover:border-black/25"
      data-layout="roster"
    >
      {canOpenProject ? (
        <Link
          aria-label={t("Open {name}", { name: item.name })}
          className="group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--ad-ink)]"
          href={characterHref}
        >
          {identity}
        </Link>
      ) : (
        identity
      )}
      <div className="mt-auto border-t border-[var(--ad-border)] px-4 py-3 text-xs">
        {canOpenNextAction ? (
          <Link
            className="flex min-h-8 items-center justify-between gap-3 text-sm font-semibold text-[var(--ad-ink)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
            href={primaryAction.href}
          >
            <span className="truncate">{t(primaryAction.label)}</span>
            <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
          </Link>
        ) : (
          <p className="flex min-h-8 items-center text-sm font-semibold text-[var(--ad-ink)]">
            {t(primaryAction.label)}
          </p>
        )}
      </div>
    </article>
  );
}
