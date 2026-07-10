"use client";
// SPEC: 折叠容器——首屏只显示一行人话摘要；展开才见工程标识符（ID/文件名/原始码/组件表）。
// INTENT: 运营默认看不到黑话；工程需要时点开。用原生 <details>，无外部状态。
// INVARIANTS: 默认折叠（<details> 不带 open）。
import type { ReactNode } from "react";
import { useAdminI18n } from "@/components/admin/i18n";

export function EngineeringDetails({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const { t } = useAdminI18n();
  return (
    <details className="group border border-white/10 bg-black/20 text-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[rgb(170,170,170)] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate">{summary}</span>
        <span className="shrink-0 text-[11px] opacity-60">{t("Engineering details")}</span>
      </summary>
      <div className="border-t border-white/10 px-3 py-2 font-mono break-all text-[rgb(170,170,170)]">
        {children}
      </div>
    </details>
  );
}
