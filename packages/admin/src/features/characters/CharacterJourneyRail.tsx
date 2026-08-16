"use client";

import Link from "next/link";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";

/**
 * SPEC: 角色详情页顶部的生产进度条 —— 服务端 journey 投影的唯一渲染处。
 * INTENT: 投影每次都下发 5 步状态机和 blockers，但全仓一处都没渲染过。运营打开角色页
 *         只能靠逐个 tab 点进去猜「这个角色现在卡在哪、还差几件事」。
 * INVARIANT: 这里只读投影，不做任何本地推导。步骤完成度、受阻原因、深链全部来自后端；
 *            前端再算一遍就会出现「进度条说齐了、面板说缺 2 张」这种自相矛盾。
 */

type CharacterJourney = CharacterWorkspaceDetail["journey"];
type JourneyStep = CharacterJourney["steps"][number];

const STEP_LABEL: Record<JourneyStep["code"], string> = {
  visual_identity: "Visual identity",
  image_assets: "Image assets",
  preview_qa: "Launch preview",
  release: "Release",
  live_monitor: "Live monitoring",
};

// 步骤态说的是"这一步做完没有"，用 Done/In progress 而不是枚举原词——运营读的是进度，
// 不是状态机。
const STEP_STATE_LABEL: Record<JourneyStep["state"], string> = {
  complete: "Done",
  current: "In progress",
  upcoming: "Not started",
  blocked: "Blocked",
};

// SEAM: ui/status-tone.ts 只认 blocked，没有 complete/current/upcoming。
// 等它覆盖这四个值再换过去，不在这里另起一份通用 tone 表。
const STEP_TONE: Record<JourneyStep["state"], string> = {
  complete: "border-[var(--ad-green-text)]/40 text-[var(--ad-green-text)]",
  current: "border-[var(--ad-ink)] text-[var(--ad-ink)]",
  upcoming: "border-[var(--ad-border)] text-[var(--ad-text-muted)]",
  blocked: "border-[var(--ad-red-text)]/50 text-[var(--ad-red-text)]",
};

export function CharacterJourneyRail({
  journey,
  onOpenDeepLink,
}: {
  journey: CharacterJourney;
  onOpenDeepLink: (deepLink: string) => void;
}) {
  const { t } = useAdminI18n();
  // INTENT: 保留真实 href（可复制、可中键新开），但普通点击走同页 tab 切换。
  //         next/link 直接跳 ?tab= 只会改地址栏——tab 是 React state，不会跟着变。
  const openInPage = (deepLink: string) => (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onOpenDeepLink(deepLink);
  };

  return (
    <section
      aria-labelledby="character-journey-title"
      className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold" id="character-journey-title">
          {t("Production journey")}
        </h2>
        <p
          className={cn(
            "text-xs font-semibold",
            journey.blockers.length > 0
              ? "text-[var(--ad-red-text)]"
              : "text-[var(--ad-text-muted)]",
          )}
        >
          {journey.blockers.length > 0
            ? t("{count} to resolve", { count: journey.blockers.length })
            : t("Nothing is blocking this character")}
        </p>
      </div>
      <ol
        aria-label={t("Production journey steps")}
        className="mt-3 grid gap-2 sm:grid-cols-5"
      >
        {journey.steps.map((step, index) => (
          <li key={step.code}>
            <Link
              aria-current={step.state === "current" ? "step" : undefined}
              className={cn(
                "flex min-h-11 flex-col justify-center rounded-lg border px-3 py-2 transition-colors hover:bg-black/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]",
                STEP_TONE[step.state],
              )}
              href={step.deepLink}
              onClick={openInPage(step.deepLink)}
            >
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em]">
                {index + 1} · {t(STEP_STATE_LABEL[step.state])}
              </span>
              <span className="mt-0.5 truncate text-sm font-semibold text-[var(--ad-ink)]">
                {t(STEP_LABEL[step.code])}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {journey.blockers.length > 0 ? (
        <ul
          aria-label={t("Blockers")}
          className="mt-3 space-y-2 border-t border-[var(--ad-border)] pt-3"
        >
          {journey.blockers.map((blocker) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
              key={blocker.code}
            >
              <span className="min-w-0 text-[var(--ad-red-text)]">
                {t(blocker.message)}
              </span>
              <Link
                className="shrink-0 text-xs font-semibold underline"
                href={blocker.deepLink}
                onClick={openInPage(blocker.deepLink)}
              >
                {t("Resolve")}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
