"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import type { CharacterPortfolioItem } from "@idream/shared/admin";
import { ArrowRight, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CharacterPortfolioVisual } from "./CharacterPortfolioVisual";

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
  platform_route_unavailable: {
    description:
      "No qualified image route can serve this Character. This is a platform configuration issue you cannot fix on this page; platform operations manages it under Profiles & Rollout.",
    eyebrow: "Platform issue",
    label: "Open Profiles & Rollout",
    requiresAssets: false,
  },
  retry_failed_image_run: {
    description:
      "The latest image failed without a result. Open Images and generate it again.",
    eyebrow: "Image generation failed",
    label: "Generate again",
    requiresAssets: true,
  },
  resolve_unknown_image_run: {
    description:
      "The latest image has an unknown outcome and may already have cost money. Check that Run before generating again.",
    eyebrow: "Image outcome unknown",
    label: "Check image Run",
    requiresAssets: true,
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
  repair_character_soul: {
    description:
      "The images are ready, but the persona or opening message must be saved again before it can be published.",
    eyebrow: "Persona needs repair",
    label: "Repair persona",
    requiresAssets: false,
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
  // SPEC: 走到这里说明线上没有任何待办。不要写成一个看起来要做的动作，运营不需要被提醒。
  monitor_live_character: {
    description: "Nothing needs you right now. Live monitoring is here if you want it.",
    eyebrow: "Live character",
    label: "No action needed",
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
  // SPEC: 卡片主动作只服从这个优先级：未完成命令 → 归档/停用 → 旅程阻塞 → Release 阻塞 → 线上零观测
  //       → 待发布版本 → 待发布修订 → 线上图片包缺失 → 普通制作旅程。
  // INTENT: 生成批次只是生产过程，不能盖过线上故障或发布决策。
  if (item.journey.primaryAction.code === "recover_active_command") return journeyAction;
  if (item.serving.state === "retired") {
    const archivedDraft = item.serving.currentReleaseId === null;
    return {
      description: archivedDraft
        ? "Restore this archived draft before continuing character production."
        : "This character is retired. Review its release history.",
      eyebrow: archivedDraft ? "Archived draft" : "Retired character",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=release`,
      label: archivedDraft ? "Restore draft" : "Review retired character",
      requiresAssets: false,
    };
  }
  if (item.journey.status === "blocked") return journeyAction;
  // INTENT: a paused Character with nothing new to publish has one decision left —
  //         resume or keep it hidden — and that control lives under Release.
  if (
    item.serving.state === "paused" &&
    item.journey.primaryAction.code === "monitor_live_character"
  ) {
    return {
      description:
        "Customers cannot open this paused character. Resume it or keep it hidden under Release availability.",
      eyebrow: "Paused character",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=release`,
      label: "Review paused character",
      requiresAssets: false,
    };
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
  // SPEC: 对照 ReleasePanel：路线资格失效的线上 Release 要重新发布，内容一致也不能自动恢复。
  if (item.currentRelease?.status === "published" && item.readiness === "stale") {
    return {
      description:
        "The live Release lost its route qualification. Customers still see it; publish again to bring it back to a checked state.",
      eyebrow: "Live release stale",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=release`,
      label: "Publish again",
      requiresAssets: false,
    };
  }
  // SPEC: 权威判定"表现数据不可信"要比"没有数据"更早说出来。
  // INTENT: qualityState=invalid 的意思是漏斗事实自相矛盾或曝光链不精确（performance.ts:191-198），
  //         也就是这张卡上的数字不能用来做决定。此前这个状态在前端没有任何出口：
  //         needsAttention 只覆盖"发布满 7 天零观测"(no_data)，invalid 的角色因此和正常角色
  //         长得一模一样，运营会照着一份已知有问题的数据做下架和资源分配。
  if (item.operationalState.qualityState === "invalid") {
    return {
      description:
        "The performance authority marked this Character's funnel facts invalid, so these numbers cannot support a decision.",
      eyebrow: "Performance data invalid",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=monitor`,
      label: "Inspect performance quality",
      requiresAssets: false,
    };
  }
  if (item.attentionReason === "release_monitor_action") {
    return {
      description:
        "The published monitor needs a decision. Review its evidence, then keep or roll back this Release.",
      eyebrow: "Monitor needs action",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=monitor`,
      label: "Review monitor evidence",
      requiresAssets: false,
    };
  }
  if (item.attentionReason === "no_traffic_after_window") {
    return {
      description:
        "No exposure, funnel, or chat traffic in 7 days live. Check placement targeting and event delivery.",
      eyebrow: "No traffic after 7 days",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=monitor`,
      label: "Inspect live monitoring",
      requiresAssets: false,
    };
  }
  if (
    item.journey.primaryAction.code === "publish_character" ||
    item.journey.primaryAction.code === "retry_failed_image_run"
  ) {
    return journeyAction;
  }
  // INTENT: 创作者改了已发布角色只会写 Revision、不动 Serving；这里不出声，改动就一直停在未发布。
  const pendingRevision = item.journey.release.pendingRevision;
  if (pendingRevision) {
    return {
      description:
        "A newer Character revision is saved but the live Release still serves the previous one.",
      eyebrow: "Unpublished revision",
      href: pendingRevision.deepLink,
      label: "Prepare release",
      requiresAssets: false,
    };
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
  // SPEC: 对照 ReleasePanel：legacy Release 在线上照常，靠发布一次经过检查的版本离开。
  // INTENT: 不算故障，排在所有真实待办之后，只在别无他事时提示。
  if (
    item.currentRelease?.legacy === true &&
    !item.journey.release.candidateReleaseId &&
    item.journey.primaryAction.code === "monitor_live_character"
  ) {
    return {
      description:
        "This Release predates current checks. It keeps serving; publish once to move it onto a checked Release.",
      eyebrow: "Legacy release",
      href: `/admin/characters/${encodeURIComponent(item.characterId)}?tab=release`,
      label: "Publish a checked Release",
      requiresAssets: false,
    };
  }
  return journeyAction;
}

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
      label: item.serving.state === "paused" ? "Paused" : item.serving.currentReleaseId === null ? "Archived" : "Retired",
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
  if (item.journey.primaryAction.code === "repair_character_soul") {
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
  onToggleSelected,
  selected = false,
}: {
  canOpenAssets: boolean;
  canOpenProject: boolean;
  eager?: boolean;
  item: CharacterPortfolioItem;
  onToggleSelected?: () => void;
  selected?: boolean;
}) {
  const { t } = useAdminI18n();
  const primaryAction = resolveCharacterPortfolioPrimaryAction(item);
  const canOpenNextAction =
    canOpenProject && (!primaryAction.requiresAssets || canOpenAssets);
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
