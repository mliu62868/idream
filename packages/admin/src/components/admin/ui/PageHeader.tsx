import type { ReactNode } from "react";

// SPEC: 每页固定头 —— 页名 + 一句话用途（必填）+ 右侧主动作（spec §4.2）。
export function PageHeader({
  title,
  purpose,
  action,
}: {
  title: string;
  purpose: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-[var(--ad-ink)]">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--ad-text-muted)]">{purpose}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
