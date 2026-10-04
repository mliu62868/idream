"use client";

// SPEC: 站内公告 banner（BackendFeatureSpec 公告契约）。读公开 /api/v1/announcements，
//       显示最靠前一条；可关闭（localStorage 记 dismissed id）；无公告 → null。
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, X } from "lucide-react";
import {
  isSafeExternalHref,
  isSafeInternalPath,
  parseAnnouncementsResponse,
  type PublicAnnouncement,
} from "@/lib/public-api-contracts";
import { useAgeGateAccess } from "./AgeGateBoundary";

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
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [items, setItems] = useState<PublicAnnouncement[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");

  useEffect(() => {
    if (!ageGateAccepted) return;
    let cancelled = false;
    fetch("/api/v1/announcements", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Announcements unavailable");
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        // 在 async 回调里 setState（非 effect 体内同步），并一并读取已关闭列表。
        setDismissed(readDismissed());
        setItems(parseAnnouncementsResponse(payload).items);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [ageGateAccepted]);

  const next = items.find((item) => !dismissed.includes(item.id));
  // Announcements are optional; a failed read hides the banner instead of
  // pinning an outage strip to the top of every page.
  if (loadState === "error") return null;
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
    <div className={`${tone} text-white`} data-testid="announcement-banner">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 text-sm">
        <span className="flex-1">
          <span className="font-semibold">{next.title}</span>
          {next.body ? <span className="ml-2 text-white/80">{next.body}</span> : null}
        </span>
        {next.href ? <AnnouncementLink href={next.href} /> : null}
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

function AnnouncementLink({ href }: { href: string }) {
  if (!isSafeAnnouncementHref(href)) return null;

  const className = "inline-flex shrink-0 items-center gap-1.5 underline";

  if (isExternalHref(href)) {
    return (
      <a
        className={className}
        data-testid="announcement-link"
        data-link-kind="external"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        Learn more
        <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
      </a>
    );
  }

  return (
    <Link className={className} data-testid="announcement-link" data-link-kind="internal" href={href}>
      Learn more
      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
    </Link>
  );
}

function isSafeAnnouncementHref(href: string) {
  return isSafeInternalPath(href) || isSafeExternalHref(href);
}

function isExternalHref(href: string) {
  return isSafeExternalHref(href);
}
