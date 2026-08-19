import { useAdminI18n } from "@/components/admin/i18n";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { useAdminFormat } from "@/components/admin/ui/format";
import { statusTone, STATUS_TONE_CLASS, type StatusTone } from "@/components/admin/ui/status-tone";

export const fieldClass =
  "h-11 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-ink)] outline-none transition focus:border-[var(--ad-ink)] focus:ring-2 focus:ring-[var(--ad-ink)]/10";

export const textAreaClass = `${fieldClass} min-h-24 resize-y py-2`;

export function WorkspaceButton({
  children,
  className,
  tone = "default",
  type = "button",
  ...buttonProps
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  tone?: "default" | "primary" | "danger";
}) {
  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold transition-transform active:translate-y-px disabled:cursor-not-allowed disabled:border-[#c9c7c0] disabled:bg-[#e7e5df] disabled:text-[#5d5f59]",
        tone === "primary" && "border-[var(--ad-ink)] bg-[var(--ad-ink)] text-white hover:bg-[#30322e]",
        tone === "danger" && "border-[var(--ad-red-text)]/25 bg-[var(--ad-red-bg)] text-[var(--ad-red-text)] hover:bg-[var(--ad-red-hover)]",
        tone === "default" && "border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text)] hover:bg-black/[0.04]",
        className,
      )}
      {...buttonProps}
      type={type}
    >
      {children}
    </button>
  );
}

// SPEC: tone 省略时走 ui/status-tone.ts 的全站唯一词表；显式 tone 是调用方的刻意覆盖。
// INTENT: 这里曾有一份私有的四档映射，neutral 渲染成**蓝色**，而且不认识 approved / active /
//         succeeded —— 同一个 active，Placements 页绿、Cases 页蓝。现在两处逐字同色。
const LEGACY_TONE: Record<"good" | "warn" | "bad", StatusTone> = {
  good: "success",
  warn: "pending",
  bad: "danger",
};

export function StatusBadge({ value, tone }: { value: string; tone?: "good" | "warn" | "bad" | "neutral" }) {
  const { t } = useAdminI18n();
  const resolvedTone: StatusTone = tone
    ? (tone === "neutral" ? "neutral" : LEGACY_TONE[tone])
    : statusTone(value);
  return (
    <span className={cn("inline-flex min-h-7 items-center rounded-sm px-2 text-xs font-semibold", STATUS_TONE_CLASS[resolvedTone])}>
      {t(value.replaceAll("_", " "))}
    </span>
  );
}

export function LoadingWorkspace({ label }: { label: string }) {
  const { t } = useAdminI18n();
  return (
    <div aria-busy="true" aria-label={t(label)} className="space-y-4 rounded-xl bg-[var(--ad-surface)] p-5" role="status">
      <span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> {t(label)}</span>
      <div aria-hidden="true" className="grid animate-pulse gap-3 sm:grid-cols-3">
        <span className="h-16 rounded-md bg-black/[0.05]" />
        <span className="h-16 rounded-md bg-black/[0.05]" />
        <span className="h-16 rounded-md bg-black/[0.05]" />
        <span className="h-24 rounded-md bg-black/[0.04] sm:col-span-3" />
      </div>
    </div>
  );
}

// SPEC: 队列空态复用 ui/EmptyState —— 两种空（队列本来就是空 / 当前筛选没命中）各有出口。
export function EmptyWorkspace({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <EmptyState
      hint={filtered
        ? "The authority searched the full queue. Clear filters to return to the default operational view."
        : "New work appears here as incidents and cases are raised."}
      kind={filtered ? "filtered" : "empty"}
      onClearFilters={filtered ? onClear : undefined}
      title={filtered ? "No work matches these filters" : "The queue is clear"}
    />
  );
}

export function RelativeTime({ referenceTime, value }: { referenceTime: string; value: string }) {
  const format = useAdminFormat();
  return (
    <time dateTime={value} title={`${format.dateTime(value)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`}>
      {format.relativeTime(value, referenceTime)}
    </time>
  );
}
