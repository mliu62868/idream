"use client";
import { FilterX, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export type EmptyStateKind = "empty" | "filtered";

// SPEC: 空态给引导（标题+提示+行动按钮），不是一行灰字（spec §7）。
// SPEC: 两种空不是一种 —— "还没有数据"要给创建入口，"当前筛选无结果"要给清除筛选。
// INTENT: 只有一种空态时，运营在筛出零行的页面上看到的是"还没有数据"，会以为库是空的，
//         于是去后端查为什么"数据没了"。图标与下一步动作必须把两者分开。
export function EmptyState({
  title,
  hint,
  action,
  kind = "empty",
  onClearFilters,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  kind?: EmptyStateKind;
  /** Renders the standard "Clear filters" way out when the caller has no richer action. */
  onClearFilters?: () => void;
}) {
  const { t } = useAdminI18n();
  const Icon = kind === "filtered" ? FilterX : Inbox;
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-6 py-16 text-center">
      <Icon aria-hidden className="h-6 w-6 text-[var(--ad-text-muted)]" />
      <p className="text-sm font-medium text-[var(--ad-ink)]">{t(title)}</p>
      {hint ? <p className="max-w-md text-xs text-[var(--ad-text-muted)]">{t(hint)}</p> : null}
      {action ?? (onClearFilters ? (
        <button
          className="min-h-9 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold"
          onClick={onClearFilters}
          type="button"
        >
          {t("Clear filters")}
        </button>
      ) : null)}
    </div>
  );
}
