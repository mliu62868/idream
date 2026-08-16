"use client";
// SPEC: 折叠容器——首屏只显示一行人话摘要；展开才见工程标识符（ID/文件名/原始码/组件表）。
// INTENT: 运营默认看不到黑话；工程需要时点开。用原生 <details>，无外部状态。
// INVARIANTS: 默认折叠（<details> 不带 open）。
// WHY(chevron): 右侧曾无条件打印字面量 "Engineering details"，和调用方自己的 summary 叠加成
//   「Connection details … Engineering details」「Engineering details … Engineering details」。
//   可展开的提示交给 chevron——它不会和任何 summary 撞车。
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";

export function EngineeringDetails({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const { t } = useAdminI18n();
  return (
    <details className="rounded-lg group border border-[var(--ad-border)] bg-black/[0.03] text-xs">
      <summary
        aria-label={t("Engineering details")}
        className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[var(--ad-text-muted)] [&::-webkit-details-marker]:hidden"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-[var(--ad-border)] px-3 py-2 font-mono break-all text-[var(--ad-text-muted)]">
        {children}
      </div>
    </details>
  );
}
