import type { ReactNode } from "react";

// SPEC: 空态给引导（标题+提示+行动按钮），不是一行灰字（spec §7）。
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-6 py-16 text-center">
      <p className="text-sm font-medium text-[var(--ad-ink)]">{title}</p>
      {hint ? <p className="text-xs text-[var(--ad-text-muted)]">{hint}</p> : null}
      {action}
    </div>
  );
}
