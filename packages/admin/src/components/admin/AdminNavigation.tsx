"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "./i18n";
import { WORKSPACE_ICONS, type AdminWorkspace, type NavItem } from "./nav-config";

type NavigationGroup = { group: AdminWorkspace; items: NavItem[] };

// 一个目录同时服务桌面与抽屉。分组只展开，只有具名页面链接才能导航。
// 父级按 section id 重建：直接访问、搜索和 query 切页都展开当前页及其工具层。
export function AdminNavigation({ activeItem, groups, onNavigate }: {
  activeItem: NavItem;
  groups: NavigationGroup[];
  onNavigate?: () => void;
}) {
  const { t } = useAdminI18n();
  const id = useId();
  const currentLinkRef = useRef<HTMLAnchorElement | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<AdminWorkspace | null>(activeItem.group);
  const [toolsOpen, setToolsOpen] = useState(activeItem.navigation === "tool");

  useEffect(() => {
    const link = currentLinkRef.current;
    const nav = link?.closest("nav");
    if (!link || !nav) return;
    const viewport = nav.getBoundingClientRect();
    if (viewport.height === 0) return; // 隐藏的桌面目录不能干扰移动抽屉。
    const current = link.getBoundingClientRect();
    // 只滚动目录；scrollIntoView 会连带移动正文，破坏详情页的阅读位置。
    if (current.bottom > viewport.bottom - 12) nav.scrollTop += current.bottom - viewport.bottom + 12;
    else if (current.top < viewport.top + 12) nav.scrollTop += current.top - viewport.top - 12;
  }, [activeItem.id, expandedGroup, groups, toolsOpen]);

  function pageLink(item: NavItem, primary = false) {
    const active = item.id === activeItem.id;
    const Icon = item.icon;
    return (
      <Link
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-[13px] text-[var(--ad-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--ad-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-2px]",
          active && "bg-[var(--ad-surface-subtle)] font-semibold text-[var(--ad-ink)]",
        )}
        href={item.href}
        key={item.id}
        onNavigate={onNavigate}
        ref={active ? currentLinkRef : undefined}
      >
        {primary ? <Icon aria-hidden="true" className="h-4 w-4 shrink-0" /> : null}
        <span>{t(item.label)}</span>
      </Link>
    );
  }

  return groups.map(({ group, items }, index) => {
    if (group === "Today") return <div className="mb-3" key={group}>{items.map((item) => pageLink(item, true))}</div>;
    const Icon = WORKSPACE_ICONS[group];
    const expanded = expandedGroup === group;
    const active = activeItem.group === group;
    const panelId = `${id}-${group.replaceAll(" ", "-")}`;
    const regular = items.filter((item) => item.navigation !== "tool");
    const tools = items.filter((item) => item.navigation === "tool");
    const maintenance = group === "Platform Operations" || group === "System";
    const previousGroup = groups[index - 1]?.group;
    const startsMaintenance = maintenance && previousGroup !== "Platform Operations" && previousGroup !== "System";
    const toolLabel = group === "Platform Operations" ? "Tools & diagnostics" : "History & specialist tools";

    return (
      <div className={cn("mb-1", startsMaintenance && "mt-3 border-t border-[var(--ad-border)] pt-3")} key={group}>
        <button
          aria-controls={expanded ? panelId : undefined}
          aria-expanded={expanded}
          className={cn(
            "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] font-medium text-[var(--ad-text-muted)] hover:bg-black/[0.04] hover:text-[var(--ad-ink)] focus-visible:outline-2 focus-visible:outline-offset-[-2px]",
            active && "font-semibold text-[var(--ad-ink)]",
          )}
          onClick={() => {
            setExpandedGroup(expanded ? null : group);
            setToolsOpen(active && activeItem.navigation === "tool");
          }}
          type="button"
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>{t(group)}</span>
          <ChevronRight aria-hidden="true" className={cn("ml-auto h-4 w-4 shrink-0", expanded && "rotate-90")} />
        </button>
        {expanded ? (
          <div className="ml-5 border-l border-[var(--ad-border)] pl-2" id={panelId}>
            {regular.map((item) => pageLink(item))}
            {regular.length === 0 ? tools.map((item) => pageLink(item)) : tools.length > 0 ? (
              <>
                <button
                  aria-controls={toolsOpen ? `${panelId}-tools` : undefined}
                  aria-expanded={toolsOpen}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-[var(--ad-text-muted)] hover:bg-black/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                  onClick={() => setToolsOpen(!toolsOpen)}
                  type="button"
                >
                  <span>{t(toolLabel)}</span>
                  <ChevronRight aria-hidden="true" className={cn("ml-auto h-3.5 w-3.5 shrink-0", toolsOpen && "rotate-90")} />
                </button>
                {toolsOpen ? <div id={`${panelId}-tools`}>{tools.map((item) => pageLink(item))}</div> : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  });
}
