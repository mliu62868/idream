"use client";

import type { KeyboardEvent } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import type { CharacterWorkspaceTab } from "@/features/image-workflow-transport";
import { fieldClass } from "@/features/operations/WorkspaceUi";
import { cn } from "@/lib/utils";

type Tab = CharacterWorkspaceTab;

const characterWorkspaceTabLabels: Record<Tab, string> = {
  project: "Overview",
  soul: "Persona",
  visual: "Appearance & identity",
  assets: "Images",
  video: "Videos",
  voice: "Voice",
  release: "Release and preview",
  monitor: "Live monitoring",
};

export function characterWorkspaceTabLabel(tab: Tab) {
  return characterWorkspaceTabLabels[tab];
}

export type CharacterWorkspaceArea = "overview" | "settings" | "assets" | "launch";

const characterWorkspaceAreaLabels: Record<CharacterWorkspaceArea, string> = {
  overview: "Overview",
  settings: "Setup",
  assets: "Assets",
  launch: "Go live",
};

// INTENT: 角色详情按运营心智分组渲染：先看概览，再定义角色（设定）、管理素材、决定线上（上线）。
// 分组只决定导航外观；旧 tab 值继续作为 URL 和功能权威，深链与别名（?tab=preview）不受影响。
export const characterWorkspaceAreaTabs: Record<
  CharacterWorkspaceArea,
  readonly Tab[]
> = {
  overview: ["project"],
  settings: ["soul", "visual", "voice"],
  assets: ["assets", "video"],
  launch: ["release", "monitor"],
};

const characterWorkspaceAreas = Object.keys(
  characterWorkspaceAreaTabs,
) as CharacterWorkspaceArea[];

// SPEC: 方向键 / Home / End 在全部 tab 间按分组顺序线性移动，跨组不停顿。
export const CHARACTER_WORKSPACE_TABS: readonly Tab[] = characterWorkspaceAreas.flatMap(
  (area) => characterWorkspaceAreaTabs[area],
);

export function characterWorkspaceAreaLabel(area: CharacterWorkspaceArea) {
  return characterWorkspaceAreaLabels[area];
}

export function characterWorkspaceAreaForTab(tab: Tab): CharacterWorkspaceArea {
  return (
    characterWorkspaceAreas.find((area) =>
      characterWorkspaceAreaTabs[area].includes(tab),
    ) ?? "overview"
  );
}

// SPEC: 角色工作区的分组导航：移动端是带 optgroup 的页面选择器，桌面端是分组 tablist。
// 写入锁期间只有当前 tab 可用；命令待决时方向键不切页（选择本身仍由 onSelectTab 守写入锁）。
export function CharacterWorkspaceNav({
  tab,
  writesLocked,
  keyboardLocked,
  onSelectTab,
}: {
  tab: Tab;
  writesLocked: boolean;
  keyboardLocked: boolean;
  onSelectTab: (next: Tab) => void;
}) {
  const { t } = useAdminI18n();
  const onTabKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: number,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (keyboardLocked) return;
    const visibleTabs = CHARACTER_WORKSPACE_TABS;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visibleTabs.length - 1
          : (current +
              (event.key === "ArrowRight" ? 1 : -1) +
              visibleTabs.length) %
            visibleTabs.length;
    const next = visibleTabs[nextIndex];
    onSelectTab(next);
    document.getElementById(`character-tab-${next}`)?.focus();
  };
  return (
    <>
      <label className="mt-4 block sm:hidden">
        <span className="sr-only">{t("Workspace page")}</span>
        <select
          aria-label={t("Workspace page")}
          className={fieldClass}
          disabled={writesLocked}
          onChange={(event) => onSelectTab(event.target.value as Tab)}
          value={tab}
        >
          {characterWorkspaceAreas.map((area) => (
            <optgroup key={area} label={t(characterWorkspaceAreaLabel(area))}>
              {characterWorkspaceAreaTabs[area].map((item) => (
                <option key={item} value={item}>
                  {t(characterWorkspaceTabLabel(item))}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div
        className="mt-4 hidden items-end overflow-x-auto border-b border-[var(--ad-border)] sm:flex"
        role="tablist"
        aria-label={t("Character workspace")}
      >
        {characterWorkspaceAreas.map((area, areaIndex) => {
          const groupLabelId = `character-tab-group-${area}`;
          const activeArea = characterWorkspaceAreaForTab(tab) === area;
          return (
            <div
              className={cn(
                "flex shrink-0 flex-col",
                areaIndex > 0 && "ml-2 border-l border-[var(--ad-border)] pl-2",
              )}
              data-testid={`character-tab-group-${area}`}
              key={area}
              role="presentation"
            >
              {/* SPEC: 组名可见；概览只有一个 tab，组名与 tab 同名，留空位只为对齐。 */}
              <span
                aria-hidden="true"
                className={cn(
                  "px-3 pt-1 text-[11px] font-semibold uppercase tracking-wide",
                  activeArea ? "text-[var(--ad-ink)]" : "text-[var(--ad-text-muted)]",
                )}
                id={groupLabelId}
              >
                {area === "overview" ? " " : t(characterWorkspaceAreaLabel(area))}
              </span>
              <div className="flex gap-1" role="presentation">
                {characterWorkspaceAreaTabs[area].map((item) => (
                  <button
                    aria-controls={`character-panel-${item}`}
                    aria-describedby={area === "overview" ? undefined : groupLabelId}
                    aria-selected={tab === item}
                    className={cn(
                      "min-h-11 shrink-0 border-b-2 px-3 text-sm focus-visible:outline focus-visible:outline-2",
                      tab === item
                        ? "border-[var(--ad-ink)] font-semibold text-[var(--ad-ink)]"
                        : "border-transparent text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]",
                    )}
                    disabled={writesLocked && item !== tab}
                    id={`character-tab-${item}`}
                    key={item}
                    onClick={() => onSelectTab(item)}
                    onKeyDown={(event) => onTabKey(event, CHARACTER_WORKSPACE_TABS.indexOf(item))}
                    role="tab"
                    tabIndex={tab === item ? 0 : -1}
                    type="button"
                  >
                    {t(characterWorkspaceTabLabel(item))}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
