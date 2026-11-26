"use client";

import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import {
  parseChatSessionDetailResponse,
  type RuntimeChatSession as ChatSession,
} from "@/lib/public-api-contracts";
import { UNCONFIRMED_GENERATION_POLL_MS } from "@/lib/generation-failure-copy";
import type { ViewerGate } from "@/hooks/useViewerGate";
import { chatStreamLatestReplyFailed, type useChatReplyDelivery } from "../chat-reply-delivery";

export type ChatLoadState = "loading" | "ready" | "signed-out" | "error";

const PROACTIVE_POLL_MS = 60_000;

type SessionSyncOptions = {
  readonly id: string;
  readonly groupMode: boolean;
  readonly sessionPath: string;
  readonly viewer: ViewerGate;
  readonly ageGateAccepted: boolean;
  readonly delivery: ReturnType<typeof useChatReplyDelivery>;
  readonly fetchForSession: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly selectedSpeakerRef: MutableRefObject<string | null>;
  readonly receiptOwnerScopeRef: MutableRefObject<string | null>;
  readonly setLoadState: (state: ChatLoadState) => void;
  readonly onStatus: (status: string | null) => void;
  /** Clears every conversation-owned surface before the first read. */
  readonly onReset: () => void;
  /** The first read of this conversation succeeded. */
  readonly onLoaded: () => void;
  readonly suspendReceipts: (clear: boolean) => void;
  readonly resumeReceipts: (ownerScope: string) => void;
  readonly setReceiptOwnerScope: (ownerScope: string | null) => void;
  readonly reconciliation: {
    readonly hasActiveAttachment: boolean;
    readonly hasUnconfirmedAttachment: boolean;
    readonly hasGeneratingReply: boolean;
    readonly proactiveEnabled: boolean;
    /** A write owns the conversation; reads would race its receipt. */
    readonly writing: boolean;
  };
};

// SPEC: Main owns the conversation. This hook decides when the browser asks for
//       it: the first load, a background owner re-check on focus, and a
//       serialized poll while a reply, media job or check-in may change it.
export function useChatSessionSync(options: SessionSyncOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const { id, groupMode, ageGateAccepted, viewer, delivery } = options;

  async function fetchSession(signal?: AbortSignal): Promise<ChatSession> {
    const { sessionPath, selectedSpeakerRef, fetchForSession } = latest.current;
    const response = await fetchForSession(`${sessionPath}${groupMode && selectedSpeakerRef.current ? `?speaker=${encodeURIComponent(selectedSpeakerRef.current)}` : ""}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw chatSessionFetchError(response.status);
    const session = parseChatSessionDetailResponse(await response.json()).session;
    const currentViewer = latest.current.viewer;
    if (session.id !== id) throw new Error("Chat unavailable");
    if (groupMode !== Boolean(session.group)) throw new Error("Chat unavailable");
    if (currentViewer.scope && session.ownerScope !== currentViewer.scope) throw chatSessionFetchError(403);
    if (currentViewer.identity?.kind === "anonymous" && session.ownerScope.startsWith("user:")) throw chatSessionFetchError(403);
    return session;
  }

  useEffect(() => {
    if (!ageGateAccepted || !viewer.identity) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      delivery.reset();
      latest.current.onReset();
      latest.current.setLoadState("loading");
      if (viewer.identity?.kind === "anonymous") {
        latest.current.setLoadState("signed-out");
        return;
      }
      const read = delivery.context();
      read.refresh(controller.signal)
        .then((session) => {
          if (cancelled || !session) return;
          latest.current.setLoadState("ready");
          latest.current.onLoaded();
        })
        .catch((error: unknown) => {
          if (cancelled || !read.isCurrent()) return;
          latest.current.setLoadState(isChatAuthError(error) ? "signed-out" : "error");
          latest.current.onStatus(null);
        });
    }, 0);
    return () => {
      cancelled = true;
      delivery.context({ invalidate: true });
      controller.abort();
      window.clearTimeout(timer);
    };
    // Same-owner refreshes use the background focus check; a confirmed owner
    // or route change gets a new private subtree and this initial loader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ageGateAccepted, id, groupMode, viewer.identity]);

  useEffect(() => {
    if (!ageGateAccepted || viewer.identity?.kind !== "user") return;
    let controller: AbortController | null = null;
    const focus = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const read = delivery.context({ invalidate: true });
      const scopeBefore = latest.current.receiptOwnerScopeRef.current;
      latest.current.suspendReceipts(true);
      latest.current.setReceiptOwnerScope(null);
      // INTENT: re-validate in the background. Swapping the conversation for a
      // spinner on every window focus dropped the scroll position, the composer
      // and any playing voice; the page only changes when the owner check fails.
      void read.refresh(signal).then((session) => {
        if (!session) return;
        latest.current.setLoadState("ready");
      }).catch(() => {
        if (signal.aborted || !read.isCurrent() || !scopeBefore) return;
        latest.current.resumeReceipts(scopeBefore);
        latest.current.setReceiptOwnerScope(scopeBefore);
      });
    };
    window.addEventListener("focus", focus);
    return () => { controller?.abort(); window.removeEventListener("focus", focus); };
    // Revalidate the same session's owner, never the cached viewer from /me.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ageGateAccepted, id, viewer.identity]);

  const { hasActiveAttachment, hasUnconfirmedAttachment, hasGeneratingReply, proactiveEnabled, writing } = options.reconciliation;
  useEffect(() => {
    if (!ageGateAccepted) return;
    const reconciling = hasActiveAttachment || hasGeneratingReply;
    if (
      // INTENT: a proactive check-in lands while nobody is sending anything, so
      // without this the open page only saw it after a refocus. A slow read is
      // enough — check-ins are hours apart; the list marker covers other pages.
      (!reconciling && !hasUnconfirmedAttachment && !proactiveEnabled) ||
      writing
    ) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let failureCount = 0;
    const settledPollMs = hasUnconfirmedAttachment ? UNCONFIRMED_GENERATION_POLL_MS : PROACTIVE_POLL_MS;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      // A visibility wake-up must not replace the in-flight read's abort handle.
      if (cancelled || controller) return;
      if (document.hidden) {
        schedule(2_000);
        return;
      }
      controller = new AbortController();
      try {
        const session = await delivery.refresh(controller.signal);
        if (cancelled || !session) return;
        failureCount = 0;
        if (reconciling && chatStreamLatestReplyFailed(session.messages)) {
          latest.current.onStatus("Reply failed to load. Please try again.");
        }
      } catch (error) {
        if (
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          failureCount += 1;
        }
      } finally {
        controller = null;
        if (!cancelled) {
          schedule(reconciling ? Math.min(12_000, 1_500 * 2 ** failureCount) : settledPollMs);
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden || cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(reconciling ? 1_500 : settledPollMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // The serialized poller is keyed by session and whether reconciliation is needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ageGateAccepted,
    hasActiveAttachment,
    hasUnconfirmedAttachment,
    hasGeneratingReply,
    id,
    proactiveEnabled,
    writing,
  ]);

  return { fetchSession };
}

export function chatSessionFetchError(status: number) {
  const error = new Error("Chat session fetch failed") as Error & { status: number };
  error.status = status;
  return error;
}

export function isChatAuthError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 401
  );
}
