"use client";

// SPEC: 站内公告 banner（ADMIN_PHASE4_DESIGN §3）。读公开 /api/v1/announcements，
//       显示最靠前一条；可关闭（localStorage 记 dismissed id）；无公告 → null。
import { useEffect, useState } from "react";
import { X } from "lucide-react";

type PublicAnnouncement = {
  id: string;
  title: string;
  body: string;
  level: "info" | "promo" | "warning";
  href: string | null;
};

const DISMISS_KEY = "od-dismissed-announcements";

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function AnnouncementBanner() {
  const [items, setItems] = useState<PublicAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/announcements", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        // 在 async 回调里 setState（非 effect 体内同步），并一并读取已关闭列表。
        setDismissed(readDismissed());
        if (payload?.ok && Array.isArray(payload.data?.items)) {
          setItems(payload.data.items as PublicAnnouncement[]);
        }
      })
      .catch(() => {
        // 公告非关键路径：拉取失败静默（不影响页面）。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const next = items.find((item) => !dismissed.includes(item.id));
  if (!next) return null;

  function dismiss(id: string) {
    const updated = [...dismissed, id];
    setDismissed(updated);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(updated));
    } catch {
      // localStorage 不可用时仅当前会话隐藏即可。
    }
  }

  const tone =
    next.level === "warning"
      ? "bg-amber-600"
      : next.level === "promo"
        ? "bg-fuchsia-600"
        : "bg-neutral-800";

  return (
    <div className={`${tone} text-white`}>
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 text-sm">
        <span className="flex-1">
          <span className="font-semibold">{next.title}</span>
          {next.body ? <span className="ml-2 text-white/80">{next.body}</span> : null}
        </span>
        {next.href ? (
          <a className="shrink-0 underline" href={next.href}>
            Learn more
          </a>
        ) : null}
        <button
          aria-label="Dismiss announcement"
          className="shrink-0 rounded p-1 hover:bg-white/10"
          onClick={() => dismiss(next.id)}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
