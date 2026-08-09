"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Link from "next/link";
import Image from "next/image";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { RefreshCcw, Save, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import {
  WorkspaceButton,
  fieldClass,
  textAreaClass,
} from "@/features/operations/WorkspaceUi";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { cn } from "@/lib/utils";
import { characterReleaseOrdinals } from "./character-workspace-format";
import type {
  CharacterWorkspacePermissions,
  RunCommittedCharacterMutation,
} from "./character-workspace-permissions";

type ProjectDraft = Pick<
  CharacterWorkspaceDetail["project"],
  | "ownerId"
  | "audience"
  | "companionNeed"
  | "hypothesis"
  | "differentiation"
  | "targetPlacementKeys"
  | "successCriteria"
  | "productionPackage"
  | "qaPlan"
  | "plannedLaunchAt"
>;

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
      label: "Owner",
      value: data.project.ownerId ?? "Unassigned",
      alert: data.project.ownerId === null,
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

export function ProjectEditor({
  data,
  permissions,
  onReload,
  runCommittedMutation,
}: {
  data: CharacterWorkspaceDetail;
  permissions: CharacterWorkspacePermissions;
  onReload: () => Promise<void>;
  runCommittedMutation: RunCommittedCharacterMutation;
}) {
  const { t } = useAdminI18n();
  const initial = useMemo<ProjectDraft>(
    () => ({
      ownerId: data.project.ownerId,
      audience: data.project.audience,
      companionNeed: data.project.companionNeed,
      hypothesis: data.project.hypothesis,
      differentiation: data.project.differentiation,
      targetPlacementKeys: [...data.project.targetPlacementKeys],
      successCriteria: [...data.project.successCriteria],
      productionPackage: data.project.productionPackage,
      qaPlan: data.project.qaPlan,
      plannedLaunchAt: data.project.plannedLaunchAt,
    }),
    [data],
  );
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState<
    "Saved" | "Saving" | "Conflict" | "Failed to save"
  >("Saved");
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const savedKey = useRef(JSON.stringify(initial));
  const recentAssets = useMemo(() => characterRecentAssets(data), [data]);

  useEffect(() => {
    const key = JSON.stringify(draft);
    if (!permissions.writeProject || key === savedKey.current) return;
    setState("Saving");
    const timer = window.setTimeout(async () => {
      try {
        await runCommittedMutation({
          action: "Character Project autosave",
          commit: async () => {
            const result = await adminV2Operation(
              "PATCH /api/v2/admin/characters/:id/project",
              {
                path: { id: data.character.id },
                ifMatch: data.project.version,
                body: {
                  ...draft,
                  entityVersion: data.project.version,
                  reason: "Autosave Character Project changes",
                },
              },
            );
            setState("Saved");
            setMessage(null);
            return result;
          },
          afterRefresh: () => {
            savedKey.current = key;
            setMessage(null);
          },
        });
      } catch (reason) {
        if (reason instanceof AdminV2RequestError && reason.status === 409) {
          setState("Conflict");
          setMessage(
            "A newer server revision exists. Review your local text, then reload the authority before reapplying it.",
          );
        } else {
          setState("Failed to save");
          setMessage(
            reason instanceof Error
              ? reason.message
              : "Project autosave failed",
          );
        }
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    data.character.id,
    data.project.version,
    draft,
    permissions.writeProject,
    runCommittedMutation,
  ]);

  const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const disabled = !permissions.writeProject;
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
    <div className="space-y-5">
      <section className="border-b border-[var(--ad-border)] pb-8">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-lg font-semibold">{t("Character details")}</h3>
          {permissions.writeProject ? (
            <button
              className="min-h-10 text-sm font-semibold underline-offset-4 hover:underline"
              onClick={() => setEditing((current) => !current)}
              type="button"
            >
              {t(editing ? "Close editor" : "Edit details")}
            </button>
          ) : null}
        </div>
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
              {/* SPEC: "查看全部"必须落到这个角色的全部图片。
                  INTENT: 曾指向 ?tab=assets，但那个 tab 只呈现最近一次生成批次的候选图，
                  详情页写着"图片 16"却只能看到 1 张。图库支持 targetId 收窄，直接跳过去。 */}
              <Link
                className="text-xs font-semibold hover:underline"
                href={`/admin/creative/library?targetId=${encodeURIComponent(data.character.id)}`}
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
      {editing ? (
        <section className="grid gap-5 border-b border-[var(--ad-border)] pb-8 xl:grid-cols-[1fr_320px]">
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={disabled}>
            <legend className="mb-4 text-sm font-semibold">
              {t("Project details")}
            </legend>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Owner ID")}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) => set("ownerId", event.target.value || null)}
                value={draft.ownerId ?? ""}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Audience")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("audience", event.target.value)}
                value={draft.audience}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Companion need")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("companionNeed", event.target.value)}
                value={draft.companionNeed}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Hypothesis")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("hypothesis", event.target.value)}
                value={draft.hypothesis}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Differentiation")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("differentiation", event.target.value)}
                value={draft.differentiation}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Target placements")}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) =>
                  set(
                    "targetPlacementKeys",
                    event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
                value={draft.targetPlacementKeys.join(", ")}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)]">
              {t("Planned launch")}
              <input
                className={`${fieldClass} mt-1`}
                onChange={(event) =>
                  set(
                    "plannedLaunchAt",
                    event.target.value
                      ? new Date(event.target.value).toISOString()
                      : null,
                  )
                }
                type="datetime-local"
                value={draft.plannedLaunchAt?.slice(0, 16) ?? ""}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Success criteria")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) =>
                  set(
                    "successCriteria",
                    event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
                value={draft.successCriteria.join("\n")}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("Production package")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) =>
                  set("productionPackage", event.target.value)
                }
                value={draft.productionPackage}
              />
            </label>
            <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">
              {t("QA plan")}
              <textarea
                className={`${textAreaClass} mt-1`}
                onChange={(event) => set("qaPlan", event.target.value)}
                value={draft.qaPlan}
              />
            </label>
          </fieldset>
          <aside className="border-l border-[var(--ad-border)] pl-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">
              {t("Server draft")}
            </p>
            <div className="mt-4 flex items-center gap-2" role="status">
              <Save className="h-4 w-4" />
              <strong>{disabled ? t("Read only") : state}</strong>
            </div>
            <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
              {t("Project revision")} {data.project.version}
              {t(
                ". Autosave uses If-Match; conflicts never overwrite a newer revision.",
              )}
            </p>
            {message ? (
              <p
                className="mt-4 text-xs text-[var(--ad-yellow-text)]"
                role={state === "Failed to save" ? "alert" : "status"}
              >
                {message}
              </p>
            ) : null}
            {state === "Conflict" ? (
              <div className="mt-3">
                <WorkspaceButton
                  onClick={() => void onReload().catch(() => undefined)}
                >
                  <RefreshCcw className="h-4 w-4" /> {t("Load server revision")}
                </WorkspaceButton>
              </div>
            ) : null}
          </aside>
        </section>
      ) : null}
      <details className="border-b border-[var(--ad-border)] pb-5">
        <summary className="cursor-pointer py-2 text-sm font-semibold">
          {t("Project collaboration")}
        </summary>
        <div className="pt-4">
          <CollaborationPanel
            canWrite={permissions.writeProject}
            targetId={data.project.id}
            targetType="character_project"
            targetVersion={data.project.version}
          />
        </div>
      </details>
    </div>
  );
}
