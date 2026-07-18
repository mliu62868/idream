import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function StatusBadge({ value, tone }: { value: string; tone?: "good" | "warn" | "bad" | "neutral" }) {
  const resolvedTone = tone ?? statusTone(value);
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-sm px-2 text-xs font-semibold",
        resolvedTone === "good" && "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]",
        resolvedTone === "warn" && "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]",
        resolvedTone === "bad" && "bg-[var(--ad-red-bg)] text-[var(--ad-red-text)]",
        resolvedTone === "neutral" && "bg-[var(--ad-blue-bg)] text-[var(--ad-blue-text)]",
      )}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}

export function LoadingWorkspace({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="space-y-4 rounded-xl bg-[var(--ad-surface)] p-5" role="status">
      <span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> {label}</span>
      <div aria-hidden="true" className="grid animate-pulse gap-3 sm:grid-cols-3">
        <span className="h-16 rounded-md bg-black/[0.05]" />
        <span className="h-16 rounded-md bg-black/[0.05]" />
        <span className="h-16 rounded-md bg-black/[0.05]" />
        <span className="h-24 rounded-md bg-black/[0.04] sm:col-span-3" />
      </div>
    </div>
  );
}

export function EmptyWorkspace({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <section className="rounded-xl bg-[var(--ad-surface)] px-6 py-14 text-center">
      <h3 className="text-base font-semibold">{filtered ? "No work matches these filters" : "The queue is clear"}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--ad-text-muted)]">
        {filtered
          ? "The authority searched the full queue. Clear filters to return to the default operational view."
          : "New work appears here when authoritative signals create an incident or case."}
      </p>
      {filtered ? <div className="mt-5"><WorkspaceButton onClick={onClear}>Clear filters</WorkspaceButton></div> : null}
    </section>
  );
}

export function RelativeTime({ referenceTime, value }: { referenceTime: string; value: string }) {
  const date = new Date(value);
  const diffMinutes = Math.round((date.getTime() - new Date(referenceTime).getTime()) / 60_000);
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.abs(diffMinutes) < 60 ? diffMinutes : Math.round(diffMinutes / 60),
    Math.abs(diffMinutes) < 60 ? "minute" : "hour",
  );
  return <time dateTime={value} title={`${date.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`}>{relative}</time>;
}

function statusTone(value: string): "good" | "warn" | "bad" | "neutral" {
  if (["passed", "resolved", "closed"].includes(value)) return "good";
  if (["critical", "urgent", "failed", "overridden"].includes(value)) return "bad";
  if (["high", "detected", "overdue", "pending", "mitigating"].includes(value)) return "warn";
  return "neutral";
}
