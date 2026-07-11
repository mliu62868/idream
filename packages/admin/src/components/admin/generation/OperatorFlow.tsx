"use client";
// SPEC: 运营动线骨架——左"列表"选一项，右"详情+动作"。响应式：窄屏单栏堆叠。
// INTENT: 纯布局+选择，不含业务判断；动作可用性由调用方在 detail 里决定。
// INVARIANTS: selectedId 受控；空列表显示 empty 文案；右栏 min-w-0 防止内容把栏挤成竖排（修 config 挤压 bug）。
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";

export type OperatorFlowItem = {
  id: string;
  primary: ReactNode;
  secondary?: ReactNode;
  badge?: ReactNode;
};

export function OperatorFlow({
  items,
  selectedId,
  onSelect,
  detail,
  empty,
}: {
  items: OperatorFlowItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  detail: ReactNode;
  empty?: ReactNode;
}) {
  const { t } = useAdminI18n();
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
      <ul className="space-y-1">
        {items.length === 0 ? (
          <li className="rounded-lg border border-[var(--ad-border)] px-3 py-6 text-center text-xs text-[var(--ad-text-muted)]">
            {empty ?? t("Nothing here yet.")}
          </li>
        ) : (
          items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "rounded-lg flex w-full items-start justify-between gap-2 border px-3 py-2 text-left text-sm",
                  item.id === selectedId
                    ? "border-[var(--ad-ink)] bg-black/[0.04]"
                    : "border-[var(--ad-border)] hover:bg-black/[0.04]",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{item.primary}</span>
                  {item.secondary ? (
                    <span className="block truncate text-xs text-[var(--ad-text-muted)]">{item.secondary}</span>
                  ) : null}
                </span>
                {item.badge ? <span className="shrink-0">{item.badge}</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="min-w-0">{detail}</div>
    </div>
  );
}
