"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import {
  parseChatSessionDetailResponse,
  type RuntimeChatMessage as ChatMessage,
  type RuntimeChatSession as ChatSession,
} from "@/lib/public-api-contracts";
import { UNCONFIRMED_GENERATION_POLL_MS } from "@/lib/generation-failure-copy";
import type { ViewerGate } from "@/hooks/useViewerGate";
import { chatStreamLatestReplyFailed, type useChatReplyDelivery } from "../chat-reply-delivery";
import {
  CHAT_EARLIER_PAGE_LIMIT,
  COMPLETE_CHAT_SESSION_PAGE,
  chatSessionPage,
  chatSessionPageFromPayload,
  type ChatSessionPage,
} from "./chat-session-page";

export type ChatLoadState = "loading" | "ready" | "signed-out" | "error";

const PROACTIVE_POLL_MS = 60_000;
const RECONCILE_POLL_MS = 1_500;
const RECONCILE_MAX_BACKOFF_MS = 12_000;
// SPEC: While the generating reply's stream is live it carries the text; the
//       authority read is only a heartbeat for attachments and lost terminals.
const LIVE_STREAM_HEARTBEAT_MS = 10_000;

export function chatReconcilePollDelay(input: { readonly streamHealthy: boolean; readonly failureCount: number }): number {
  if (input.streamHealthy && input.failureCount === 0) return LIVE_STREAM_HEARTBEAT_MS;
  return Math.min(RECONCILE_MAX_BACKOFF_MS, RECONCILE_POLL_MS * 2 ** input.failureCount);
}

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
  /** Earlier messages arrived; the caller keeps the reader's place. */
  readonly onEarlierMessages: (messages: readonly ChatMessage[]) => void;
  readonly reconciliation: {
    readonly hasActiveAttachment: boolean;
    readonly hasUnconfirmedAttachment: boolean;
    readonly hasGeneratingReply: boolean;
    readonly proactiveEnabled: boolean;
    /** A write owns the conversation; reads would race its receipt. */
    readonly writing: boolean;
    /** A typed send is in flight; a snapshot now could duplicate its bubble. */
    readonly sending: boolean;
  };
};

// SPEC: Main owns the conversation. This hook decides when the browser asks for
//       it: the first load, a background owner re-check on focus, and a
//       serialized poll while a reply, media job or check-in may change it.
export function useChatSessionSync(options: SessionSyncOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const { id, groupMode, ageGateAccepted, viewer, delivery } = options;
  // Pagination: the latest page comes with every read; older pages only on request.
  const [latestPage, setLatestPage] = useState<ChatSessionPage>(COMPLETE_CHAT_SESSION_PAGE);
  const [olderPage, setOlderPage] = useState<ChatSessionPage | null>(null);
  const [earlierState, setEarlierState] = useState<"idle" | "loading" | "error">("idle");
  const conversationEpochRef = useRef(0);
  const pollWakeRef = useRef<(() => void) | null>(null);
  // A complete latest page (nothing earlier) supersedes any older cursor.
  const page = latestPage.hasEarlier ? olderPage ?? latestPage : latestPage;

  // SPEC: Reads the latest page unless a cursor is given. Page metadata is
  //       carried on the returned session so delivery can merge partial pages.
  async function fetchSession(signal?: AbortSignal, beforeTurnId?: string): Promise<ChatSession> {
    const { sessionPath, selectedSpeakerRef, fetchForSession } = latest.current;
    const query = new URLSearchParams();
    if (groupMode && selectedSpeakerRef.current) query.set("speaker", selectedSpeakerRef.current);
    if (beforeTurnId) {
      query.set("beforeTurnId", beforeTurnId);
      query.set("limit", String(CHAT_EARLIER_PAGE_LIMIT));
    }
    const search = query.toString();
    const response = await fetchForSession(`${sessionPath}${search ? `?${search}` : ""}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw chatSessionFetchError(response.status);
    const payload: unknown = await response.json();
    const session = parseChatSessionDetailResponse(payload).session;
    const currentViewer = latest.current.viewer;
    if (session.id !== id) throw new Error("Chat unavailable");
    if (groupMode !== Boolean(session.group)) throw new Error("Chat unavailable");
    if (currentViewer.scope && session.ownerScope !== currentViewer.scope) throw chatSessionFetchError(403);
    if (currentViewer.identity?.kind === "anonymous" && session.ownerScope.startsWith("user:")) throw chatSessionFetchError(403);
    return { ...session, page: chatSessionPageFromPayload(payload) };
  }

  /** Called with every applied latest-page snapshot. */
  function notePage(session: ChatSession) {
    const next = chatSessionPage(session);
    setLatestPage((current) => current.hasEarlier === next.hasEarlier && current.earliestTurnId === next.earliestTurnId ? current : next);
  }

  async function loadEarlier() {
    const cursor = page.hasEarlier ? page.earliestTurnId : null;
    if (!cursor || earlierState === "loading") return;
    const epoch = conversationEpochRef.current;
    setEarlierState("loading");
    try {
      const session = await fetchSession(undefined, cursor);
      if (epoch !== conversationEpochRef.current) return;
      latest.current.onEarlierMessages(session.messages);
      setOlderPage(chatSessionPage(session));
      setEarlierState("idle");
    } catch {
      if (epoch === conversationEpochRef.current) setEarlierState("error");
    }
  }

  useEffect(() => {
    if (!ageGateAccepted || !viewer.identity) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      delivery.reset();
      conversationEpochRef.current += 1;
      setLatestPage(COMPLETE_CHAT_SESSION_PAGE);
      setOlderPage(null);
      setEarlierState("idle");
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
      // The send's own receipt reconciles this conversation; a snapshot taken
      // before Main records the Turn would show the reader's bubble twice.
      if (latest.current.reconciliation.sending) return;
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
    const nextDelay = () => reconciling
      ? chatReconcilePollDelay({ streamHealthy: hasGeneratingReply && delivery.streamHealthy(), failureCount })
      : settledPollMs;

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
        if (!cancelled) schedule(nextDelay());
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden || cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    // A lost stream asks for the authority read now rather than at the heartbeat.
    pollWakeRef.current = () => {
      if (cancelled || controller) return;
      if (timer !== undefined) window.clearTimeout(timer);
      schedule(0);
    };
    schedule(nextDelay());
    return () => {
      cancelled = true;
      pollWakeRef.current = null;
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

  return {
    fetchSession,
    notePage,
    wakePoll: () => pollWakeRef.current?.(),
    earlier: {
      available: page.hasEarlier,
      loading: earlierState === "loading",
      failed: earlierState === "error",
      load: loadEarlier,
    },
  };
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
