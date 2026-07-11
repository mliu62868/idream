"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { StatusPill } from "./StatusPill";

// SPEC: 详情页骨架 —— ← 返回 + 名字/状态/主动作区 + 分区内容（spec §7 详情页）。
export function DetailPage({
  backHref,
  backLabel,
  title,
  status,
  statusLabel,
  actions,
  children,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  status?: string;
  statusLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl">
      <Link
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"
        href={backHref}
      >
        <ArrowLeft className="h-4 w-4" /> {backLabel}
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--ad-ink)]">{title}</h2>
          {status ? <StatusPill label={statusLabel} status={status} /> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6">
      <h3 className="mb-4 text-sm font-semibold text-[var(--ad-ink)]">{title}</h3>
      {children}
    </section>
  );
}
