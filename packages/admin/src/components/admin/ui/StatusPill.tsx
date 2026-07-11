"use client";
import { cn } from "@/lib/utils";
import { useAdminI18n } from "@/components/admin/i18n";
import { statusTone, type StatusTone } from "./status-tone";

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
  pending: "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
  danger: "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
  info: "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
  neutral: "bg-black/[0.05] text-[var(--ad-text-muted)]",
};

// SPEC: pastel 状态 pill。label 缺省时用 value(status)（zhValues 枚举通道）翻译状态词本身。
export function StatusPill({ status, label }: { status: string; label?: string }) {
  const { value } = useAdminI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em]",
        TONE_CLASSES[statusTone(status)],
      )}
    >
      {label ?? value(status)}
    </span>
  );
}
