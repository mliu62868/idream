"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import Image from "next/image";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { ShieldAlert } from "lucide-react";
import { useMemo } from "react";
import { CharacterChatToolsPanel } from "./CharacterChatToolsPanel";
import { CharacterTagsPanel } from "./CharacterTagsPanel";
import { cn } from "@/lib/utils";
import { characterReleaseOrdinals } from "./character-workspace-format";

// SPEC: 视频是 character I2V，源图恒为角色主图（service.ts 的 mode==="video" 守卫）。
// INTENT: 主图不可用时用户端视频请求会 409，但角色本身在线、运营面看不出异常。只在「已上线 +
// 主图不可用」这个真正可行动的组合下告警——未上线时缺主图已由前面的生产步骤覆盖，再报一次是噪音。
// 不新增契约字段：detail.character.imageUrl 为 null 已等价于后端的 characterImageAvailable=false。
export function characterVideoSourceBroken(data: CharacterWorkspaceDetail) {
  return data.serving?.state === "live" && data.character.imageUrl === null;
}

export type CharacterOperationsFact = {
  readonly label: string;
  readonly value: string;
  readonly alert: boolean;
};

// SPEC: 角色详情只陈述当前事实，不把服务端推导的动作包装成强制流程。
// INTENT: 版本号、项目 ID 这类排障字段留在「技术状态」里。
// 采纳数用 missingPurposes 反推，不再数一遍 draftAssetPack——路线权威只有一份。
export function characterOperationsFacts(
  data: CharacterWorkspaceDetail,
): readonly CharacterOperationsFact[] {
  const currentRelease =
    data.releases.find(
      ({ release }) => release.id === data.serving?.currentReleaseId,
    )?.release ?? null;
  const visiblePack =
    data.journey.release.servingState === "live"
      ? data.journey.assetPack.live
      : data.journey.assetPack.draft;
  const changedCount = data.preview.changedFields.length;
  const releaseOrdinals = characterReleaseOrdinals(data.releases);
  // SPEC: 身份图片按 mediaAssetId 去重后计数。
  // INTENT: anchors 与 references 会重叠（已发布参考集里的图同时也是锚点），相加会把同一张
  // 图数两次 —— 这个角色实际 15 张，页面写 16。
  const identityImageCount = new Set(
    [...data.visual.anchors, ...data.visual.references]
      .filter((asset) => asset.available)
      .map((asset) => asset.mediaAssetId),
  ).size;
  return [
    {
      label: "Serving",
      value: data.serving?.state ?? "not_live",
      alert: data.serving?.state !== "live",
    },
    { label: "Visibility", value: data.character.visibility, alert: false },
    {
      label: "Live release",
      value: currentRelease
        ? `#${releaseOrdinals.get(currentRelease.id) ?? "?"} · ${(currentRelease.publishedAt ?? currentRelease.createdAt).slice(0, 10)}`
        : "None published",
      alert: currentRelease === null,
    },
    {
      label: "Unpublished changes",
      value: changedCount === 0 ? "None" : String(changedCount),
      alert: changedCount > 0,
    },
    {
      label: "Image pack",
      value: `${visiblePack.completed}/${visiblePack.total}`,
      alert: visiblePack.completed < visiblePack.total,
    },
    {
      label: "Identity images",
      value: String(identityImageCount),
      alert: identityImageCount === 0,
    },
    // SPEC: 这一格数的是"能拿去生成视频的源图片"，不是视频数量。
    // INTENT: visual.videoSources 服务端就是一条 type:"image" 的查询，原先标签写的是
    // "Videos"，于是"视频 15"其实是 15 张图片（这个角色只有 1 个视频），而且数值恰好和图片数
    // 相同，误导更甚。0 张是真实信号：没有源图就生成不了视频。
    {
      label: "Video source images",
      value: String(
        data.visual.videoSources.filter((asset) => asset.available).length,
      ),
      alert: data.visual.videoSources.every((asset) => !asset.available),
    },
  ];
}

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

export function CharacterOverview({
  canWrite,
  data,
}: {
  canWrite: boolean;
  data: CharacterWorkspaceDetail;
}) {
  const { t } = useAdminI18n();
  const recentAssets = useMemo(() => characterRecentAssets(data), [data]);
  const characterDetails = [
    { label: "Description", value: data.character.description || "N/A" },
    { label: "Age", value: String(data.character.age) },
    { label: "Gender", value: data.character.gender || "N/A" },
    { label: "Style", value: data.character.style || "N/A" },
  ] as const;
  const operationalFacts = characterOperationsFacts(data).filter(
    (fact) => fact.label !== "Serving" && fact.label !== "Visibility",
  );
  return (
    <div className="flex flex-col gap-5">
      <section className="border-b border-[var(--ad-border)] pb-8">
        <h3 className="text-lg font-semibold">
          {t("Character profile and status")}
        </h3>
        <div className="mt-5 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] xl:divide-x xl:divide-[var(--ad-border)]">
          <dl className="grid grid-cols-2 content-start gap-x-8 gap-y-5">
            {characterDetails.map((detail) => (
              <div
                className={
                  detail.label === "Description" ? "sm:col-span-2" : undefined
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
          <div className="xl:pl-8">
            <h3 className="text-sm font-semibold">{t("Current status")}</h3>
            <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {operationalFacts.map((fact) => (
                <div key={fact.label}>
                  <dt className="text-xs text-[var(--ad-text-muted)]">
                    {t(fact.label)}
                  </dt>
                  <dd
                    className={cn(
                      "mt-1 text-sm font-semibold",
                      fact.alert && "text-[var(--ad-yellow-text)]",
                    )}
                  >
                    {t(fact.value)}
                  </dd>
                </div>
              ))}
            </dl>
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
            <CharacterTagsPanel
              canWrite={canWrite}
              characterId={data.character.id}
            />
            <CharacterChatToolsPanel
              canWrite={canWrite}
              characterId={data.character.id}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
