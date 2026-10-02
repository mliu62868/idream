"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdminI18n } from "@/components/admin/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

// One approved navigation leaves every editor on the page. CMS can have both
// a create form and an edit form, so replay must bypass all their guards.
let approvedNavigation = false;
let approvedHistoryKey: string | null = null;

// The installed DOM types do not yet include the browser Navigation API.
type HistoryNavigation = EventTarget & {
  traverseTo: (key: string) => { committed: Promise<unknown>; finished: Promise<unknown> };
};
type HistoryNavigateEvent = Event & { navigationType: string; destination: { url: string; key: string } };

export function useUnsavedChanges(dirty: boolean) {
  const { t } = useAdminI18n();
  const [pending, setPending] = useState<{ run: () => void | Promise<void> } | null>(null);
  const confirmDiscard = useCallback((run: () => void) => {
    if (dirty) setPending({ run });
    else run();
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const navigate = (event: MouseEvent) => {
      if (approvedNavigation || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const current = new URL(window.location.href);
      const next = new URL(anchor.href, current);
      if (next.origin !== current.origin || (next.pathname === current.pathname && next.search === current.search)) return;
      event.preventDefault();
      event.stopPropagation();
      setPending({ run: () => {
        approvedNavigation = true;
        try { anchor.click(); }
        finally { approvedNavigation = false; }
      } });
    };
    const historyNavigation = (window as Window & { navigation?: HistoryNavigation }).navigation;
    const traverse = (rawEvent: Event) => {
      const event = rawEvent as HistoryNavigateEvent;
      if (event.navigationType !== "traverse" || !event.cancelable || event.defaultPrevented || event.destination.key === approvedHistoryKey) return;
      const current = new URL(window.location.href);
      const next = new URL(event.destination.url, current);
      if (next.origin !== current.origin || (next.pathname === current.pathname && next.search === current.search)) return;
      event.preventDefault();
      setPending({ run: async () => {
        approvedHistoryKey = event.destination.key;
        try {
          const result = historyNavigation!.traverseTo(event.destination.key);
          await Promise.all([result.committed, result.finished]);
        } finally { approvedHistoryKey = null; }
      } });
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", navigate, true);
    historyNavigation?.addEventListener("navigate", traverse);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", navigate, true);
      historyNavigation?.removeEventListener("navigate", traverse);
    };
  }, [dirty]);

  return {
    confirmDiscard,
    guard: pending ? <ConfirmDialog onClose={() => setPending(null)} spec={{
      title: t("Discard unsaved changes?"),
      summary: t("Your unsaved changes will be lost."),
      requireReason: false,
      submitLabel: t("Discard changes"),
      onSubmit: async () => { await pending.run(); },
    }} /> : null,
  };
}
