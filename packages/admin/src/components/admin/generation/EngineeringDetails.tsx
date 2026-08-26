"use client";
// SPEC: 折叠容器——首屏只显示一行人话摘要；展开才见工程标识符（ID/文件名/原始码/组件表）。
// INTENT: 运营默认看不到黑话；工程需要时点开。用原生 <details>，无外部状态。
// INVARIANTS: 默认折叠（<details> 不带 open）。
// WHY(chevron): 右侧曾无条件打印字面量 "Engineering details"，和调用方自己的 summary 叠加成
//   「Connection details … Engineering details」「Engineering details … Engineering details」。
//   可展开的提示交给 chevron——它不会和任何 summary 撞车。
import { useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useAdminI18n } from "@/components/admin/i18n";

// WHY(onOpen): 有些工程详情的数据只有展开时才值得去取（workflow 的完整 ComfyUI 图一条 4KB，
//   目录页 8 行全预取就是 8 个白花的请求）。回调只在**第一次**展开时触发一次，
//   之后由浏览器管开合状态——这样懒加载不必各自再造一个 <details>。
export function EngineeringDetails({
  summary,
  children,
  onOpen,
}: {
  summary: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
}) {
  const { t } = useAdminI18n();
  const opened = useRef(false);
  return (
    <details
      className="rounded-lg group border border-[var(--ad-border)] bg-black/[0.03] text-xs"
      onToggle={(event) => {
        if (!event.currentTarget.open || opened.current) return;
        opened.current = true;
        onOpen?.();
      }}
    >
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
