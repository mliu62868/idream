"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

// SPEC: 全屏专注表单骨架 —— ← 返回 + 标题 + 分组区块 + 底部操作条（spec §7 新建页）。
export function FormPage({
  backHref,
  backLabel,
  title,
  children,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <Link
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
        href={backHref}
      >
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <h2 className="mb-6 text-xl font-semibold tracking-tight text-[var(--ad-ink)]">{title}</h2>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
      <h3 className="text-sm font-semibold text-[var(--ad-ink)]">{title}</h3>
      {hint ? <p className="mt-1 text-xs text-[var(--ad-text-muted)]">{hint}</p> : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function Field({
  label,
  full = false,
  children,
}: {
  label: string;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={full ? "block sm:col-span-2" : "block"}>
      <span className="mb-1.5 block text-xs font-medium text-[var(--ad-text-muted)]">{label}</span>
      {children}
    </label>
  );
}

export function FormFooter({
  error,
  notice,
  children,
}: {
  error?: string | null;
  notice?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="sticky bottom-0 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      {error ? <p role="alert" className="mb-2 text-sm text-[var(--ad-red-text)]">{error}</p> : null}
      {notice ? <p className="mb-2 text-sm text-[var(--ad-green-text)]">{notice}</p> : null}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export const INPUT_CLASS =
  "h-9 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none placeholder:text-[var(--ad-text-muted)] focus:border-[var(--ad-ink)]";
export const TEXTAREA_CLASS =
  "min-h-24 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm text-[var(--ad-text)] outline-none placeholder:text-[var(--ad-text-muted)] focus:border-[var(--ad-ink)]";
