"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import Image from "next/image";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { CharacterDistributionCard } from "./CharacterDistributionCard";
import { soulDraftFromWorkspace, visualFormFromWorkspace } from "./CharacterSoulPanel";
import { cn } from "@/lib/utils";

// SPEC: 视频是 character I2V，源图恒为角色主图（service.ts 的 mode==="video" 守卫）。
// INTENT: 主图不可用时用户端视频请求会 409，但角色本身在线、运营面看不出异常。只在「已上线 +
// 主图不可用」这个真正可行动的组合下告警——未上线时缺主图已由前面的生产步骤覆盖，再报一次是噪音。
// 不新增契约字段：detail.character.imageUrl 为 null 已等价于后端的 characterImageAvailable=false。
export function characterVideoSourceBroken(data: CharacterWorkspaceDetail) {
  return data.serving?.state === "live" && data.character.imageUrl === null;
}

// SPEC: 「为什么没上线」一屏回答：服务状态、Journey 阻塞和修复入口。已上线且无阻塞时返回空。
export function characterNotLiveReasons(
  data: CharacterWorkspaceDetail,
): readonly { readonly message: string; readonly href: string | null }[] {
  const state = data.serving?.state ?? "inactive";
  const releaseTab = `/admin/characters/${encodeURIComponent(data.character.id)}?tab=release`;
  const serving =
    state === "paused"
      ? [{ message: "Paused. Customers cannot open this character until it is resumed.", href: releaseTab }]
      : state === "retired"
        ? [{
            message: data.serving?.currentReleaseId
              ? "Retired. This character can no longer be published."
              : "Archived draft. Restore it to continue.",
            href: releaseTab,
          }]
        : state === "live"
          ? []
          : [{ message: "Not published yet.", href: null }];
  const blockers = data.journey.blockers.map((blocker) => ({
    message: blocker.message,
    href: blocker.deepLink,
  }));
  const releaseBlockers = data.portfolio.operationalState.blockers.flatMap((blocker) =>
    blocker.code === "release_blocked" || blocker.code === "release_stale"
      ? [{ message: blocker.code === "release_blocked" ? "The current Release is blocked." : "The current Release is stale. Publish again.", href: releaseTab }]
      : [],
  );
  return [...serving, ...blockers, ...releaseBlockers];
}

const CHARACTER_JOURNEY_STEP_LABELS: Record<
  CharacterWorkspaceDetail["journey"]["steps"][number]["code"],
  string
> = {
  visual_identity: "Appearance & identity",
  image_assets: "Image assets",
  preview: "Preview",
  release: "Release",
  live_monitor: "Live monitoring",
};

export function characterRecentAssets(data: CharacterWorkspaceDetail) {
  const seen = new Set<string>();
  const assets: { id: string; url: string }[] = [];
  const add = (id: string, url: string | null) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    assets.push({ id, url });
  };
  add(`${data.character.id}:primary`, data.character.imageUrl);
  for (const asset of [...data.visual.anchors, ...data.visual.references]) {
    if (asset.available)
      add(asset.mediaAssetId, asset.thumbnailUrl ?? asset.url);
  }
  return assets.slice(0, 3);
}

// SPEC: 概览只放头部没有的信息：角色资料、下一步与未上线原因、最近素材、分发情况。
// INTENT: 服务状态、可见性、当前版本、图包进度都已在头部两行状态里；概览再列一遍状态格，
//         同一个事实两处显示，还让运营以为两者口径不同。标签与聊天工具移到「设定 › 人设」。
export function CharacterOverview({
  data,
}: {
  data: CharacterWorkspaceDetail;
}) {
  const { t } = useAdminI18n();
  const recentAssets = useMemo(() => characterRecentAssets(data), [data]);
  // SPEC: 资料区显示正在编辑的草稿，与标题里的名字同源；是否已上线看头部「草稿」状态。
  // INTENT: 这里曾读 Character 行，而那一行只在发布时才更新，改完人设后标题是新名字、
  //         资料却还是线上旧值，同一屏两个来源。
  const persona = soulDraftFromWorkspace(data);
  const characterDetails = [
    { label: "Short description", value: data.preview.draft.description || "N/A" },
    { label: "Age", value: String(persona?.age ?? data.character.age) },
    { label: "Gender", value: persona?.gender ?? (data.character.gender || "N/A") },
    { label: "Style", value: visualFormFromWorkspace(data).style },
  ] as const;
  const notLiveReasons = characterNotLiveReasons(data);
  return (
    <div className="flex flex-col gap-5">
      <section className="border-b border-[var(--ad-border)] pb-8">
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] xl:divide-x xl:divide-[var(--ad-border)]">
          <div>
            <h3 className="text-lg font-semibold">{t("Character profile")}</h3>
            <dl className="mt-5 grid grid-cols-2 content-start gap-x-8 gap-y-5">
              {characterDetails.map((detail) => (
                <div
                  className={
                    detail.label === "Short description" ? "sm:col-span-2" : undefined
                  }
                  key={detail.label}
                >
                  <dt className="text-xs font-semibold text-[var(--ad-text-muted)]">
                    {t(detail.label)}
                  </dt>
                  <dd className="mt-1 break-words text-sm leading-6 text-[var(--ad-ink)]">
                    {t(detail.value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="xl:pl-8">
            <h3 className="text-sm font-semibold">{t("Production progress")}</h3>
            <ol aria-label={t("Production progress")} className="mt-3 flex flex-wrap gap-1.5 text-xs">
              {data.journey.steps.map((step) => (
                <li key={step.code}>
                  <Link
                    className={cn(
                      "inline-flex min-h-7 items-center rounded-sm px-2 hover:underline",
                      step.state === "blocked"
                        ? "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]"
                        : step.state === "current"
                          ? "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]"
                          : step.state === "complete"
                            ? "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]"
                            : "bg-[var(--ad-surface-subtle)] text-[var(--ad-text-muted)]",
                    )}
                    href={step.deepLink}
                  >
                    {t(CHARACTER_JOURNEY_STEP_LABELS[step.code])}
                  </Link>
                </li>
              ))}
            </ol>
            {notLiveReasons.length > 0 ? (
              <div className="mt-5" role="status">
                <h4 className="text-xs font-semibold text-[var(--ad-text-muted)]">
                  {t(data.serving?.state === "live" ? "What needs attention" : "Why it is not live")}
                </h4>
                <ul className="mt-2 grid gap-1.5 text-sm">
                  {notLiveReasons.map((reason) => (
                    <li className="flex flex-wrap items-baseline gap-x-2" key={reason.message}>
                      <span>{t(reason.message)}</span>
                      {reason.href ? (
                        <Link className="text-xs font-semibold underline-offset-4 hover:underline" href={reason.href}>
                          {t("Fix this")}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {characterVideoSourceBroken(data) ? (
              <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-[var(--ad-yellow-text)]">
                <ShieldAlert
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                {t(
                  "Live without a usable primary image. Video generation for this character is rejected. Repair it in Image assets.",
                )}
              </p>
            ) : null}
            <div className="mt-7 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{t("Recent assets")}</h3>
              {/* SPEC: 角色素材不离开角色上下文；图库、生成与导入都在角色的 Images 中。 */}
              <Link
                className="text-xs font-semibold hover:underline"
                href={`/admin/characters/${encodeURIComponent(data.character.id)}?tab=assets`}
              >
                {t("View all")}
              </Link>
            </div>
            {recentAssets.length > 0 ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {recentAssets.map((asset) => (
                  <Image
                    alt=""
                    className="aspect-square w-full rounded-md object-cover"
                    height={160}
                    key={asset.id}
                    loading="eager"
                    src={asset.url}
                    unoptimized
                    width={160}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--ad-text-muted)]">
                {t("No recent assets")}
              </p>
            )}
          </div>
        </div>
      </section>
      <CharacterDistributionCard data={data} />
    </div>
  );
}
