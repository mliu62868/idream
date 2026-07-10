"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusPill } from "./StatusPill";

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

// SPEC: 视觉实体卡片 —— 图（或姓名首字 monogram 兜底）+ 名 + 元信息 + 状态 pill。
// INTENT: 角色/图片是视觉内容，浏览必须直接看到图（spec §1.2）。
export function EntityCard({
  href,
  title,
  image,
  meta,
  status,
  statusLabel,
}: {
  href: string;
  title: string;
  image?: string | null;
  meta?: ReactNode;
  status?: string;
  statusLabel?: string;
}) {
  return (
    <Link
      className="group overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] transition-shadow hover:shadow-[var(--ad-shadow-hover)]"
      href={href}
    >
      <div className="relative aspect-[4/5] overflow-hidden bg-black/[0.03]">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- admin 内部工具，blob URL 不走 next/image 优化
          <img alt={title} className="h-full w-full object-cover" loading="lazy" src={image} />
        ) : (
          <div className="grid h-full w-full place-items-center text-4xl font-semibold text-[var(--ad-text-muted)]">
            {title.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="space-y-1.5 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-semibold text-[var(--ad-ink)]">{title}</p>
          {status ? <StatusPill label={statusLabel} status={status} /> : null}
        </div>
        {meta ? <div className="text-xs text-[var(--ad-text-muted)]">{meta}</div> : null}
      </div>
    </Link>
  );
}
