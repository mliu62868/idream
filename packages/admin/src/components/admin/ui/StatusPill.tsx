"use client";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";
import { statusTone, STATUS_TONE_CLASS } from "./status-tone";

// SPEC: pastel 状态 pill。label 缺省时用 value(status)（zhValues 枚举通道）翻译状态词本身。
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const { value } = useAdminI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em]",
        STATUS_TONE_CLASS[statusTone(status)],
      )}
    >
      {label ?? value(status)}
    </span>
  );
}
