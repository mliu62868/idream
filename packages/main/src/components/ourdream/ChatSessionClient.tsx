"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  Check,
  ExternalLink,
  ImageIcon,
  ListChecks,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Square,
  WandSparkles,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  parseChatSendResponse,
  parseChatSessionDetailResponse,
  parseGenerationRetryQuoteResponse,
  type RuntimeChatAttachment as ChatAttachment,
  type RuntimeChatMessage as ChatMessage,
  type RuntimeChatSession as ChatSession,
} from "@/lib/public-api-contracts";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { ChatHeaderControls } from "./chat/ChatHeaderControls";
import { ChatSessionListDrawer } from "./chat/ChatSessionListDrawer";
import { MemoryPanel } from "./chat/MemoryPanel";
import { ConversationPreferences } from "./chat/ConversationPreferences";
import { MessageActions } from "./chat/MessageActions";
import { authHrefForTarget } from "./authRedirect";
import { LegacyTestAssetBadge } from "./LegacyTestAssetBadge";
import { useReportDialog } from "./ReportDialog";
import { chatFailureCopy } from "@/lib/chat-failure-copy";
import {
  chatStreamErrorDisposition,
  chatStreamLatestReplyFailed,
  chatStreamMessageIsInProgress,
  chatStreamMessageIsTerminal,
  chatStreamMessagesNeedReconciliation,
  chatStreamTerminalErrorMessage,
  reconcileChatStreamAuthority,
} from "./chat-stream-recovery";
import {
  canRegenerateChatMessage,
  canSubmitChatMessage,
  chatMessageActionPaddingClass,
  isImmutableOpeningMessage,
  isLocalChatMessageId,
  LOCAL_CHAT_MESSAGE_ID_PREFIX,
} from "./chat-message-actions";
import {
  GenerationRequestError,
  hasUnconfirmedGenerationRetry,
  requestGenerationRetryWithExactAuthority,
  requestMediaVariationWithExactQuote,
} from "@/lib/generation-write-client";

type ChatLoadState = "loading" | "ready" | "signed-out" | "error";
type ChatUpgradeReason = "dreamcoins" | "messages" | "voice";

type VoiceClipRequestResult = {
  url: string | null;
  reason:
    | "allowance_exhausted"
    | "disabled"
    | "failed"
    | "insufficient_balance"
    | "not_entitled"
    | null;
};

const BLOCKED_ASSISTANT_NOTICE = "I can’t help with that request.";
const STOPPED_REPLY_STATUS = "cancelled";
// A reply is only auto-followed while the reader is parked within this many
// pixels of the bottom; above that the viewport belongs to the reader.
const STICK_TO_BOTTOM_SLACK_PX = 120;
const COMPOSER_BUTTON_CLASS =
  "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-white disabled:opacity-70";

type LocalStreamState = {
  readonly content: string;
  readonly stopped: boolean;
};

export function chatUpgradeLinkLabel(reason: ChatUpgradeReason) {
  if (reason === "voice") return "Upgrade for voice access";
  if (reason === "dreamcoins") return "Get more dreamcoins";
  return "Upgrade for unlimited messages";
}

export function voicePaymentRequiredReason(payload: unknown) {
  const details = (
    payload as { error?: { details?: { entitlement?: unknown } } }
  )?.error?.details;
  return details?.entitlement === "voice_enabled"
    ? ("not_entitled" as const)
    : ("insufficient_balance" as const);
}

function upgradeHrefForChatSession(sessionId: string) {
  return `/upgrade?returnTo=${encodeURIComponent(`/chat/${encodeURIComponent(sessionId)}`)}`;
}

function mergeCanonicalMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const replacements = new Map(incoming.map((message) => [message.id, message]));
  const merged = current.map((message) => replacements.get(message.id) ?? message);
  const existingIds = new Set(current.map((message) => message.id));
  return [
    ...merged,
    ...incoming.filter((message) => !existingIds.has(message.id)),
  ];
}

// SPEC: Chat streams deltas through Redis and only writes the assistant row at
//       finalize, so every read landing mid-stream returns content: "". Reapply
//       the text this client has already received so the 1.5s poller can never
//       blank a bubble the reader is watching.
// INVARIANT: a row Chat reports as terminal always wins — including a shorter
//            moderated rewrite of what streamed. Only the mid-stream hole is
//            filled locally.
export function applyLocalStreamState(
  messages: ChatMessage[],
  localState: ReadonlyMap<string, LocalStreamState>,
): ChatMessage[] {
  if (localState.size === 0) return messages;
  return messages.map((message) => {
    const local = localState.get(message.id);
    if (!local) return message;
    if (chatStreamMessageIsTerminal(message) && message.status !== STOPPED_REPLY_STATUS) {
      return message;
    }
    if (local.stopped) {
      return { ...message, content: local.content, status: STOPPED_REPLY_STATUS };
    }
    if (chatStreamMessageIsTerminal(message)) return message;
    return local.content.length > message.content.length
      ? { ...message, content: local.content }
      : message;
  });
}

// SPEC: Follow the newest message only while the reader is parked at the bottom.
// INTENT: a stream re-renders on every token; without this the reader is dragged
//         back down and can never scroll up through the history mid-reply.
export function chatViewIsPinnedToBottom(viewport: {
  readonly innerHeight: number;
  readonly scrollY: number;
  readonly scrollHeight: number;
}): boolean {
  return (
    viewport.scrollHeight - (viewport.scrollY + viewport.innerHeight) <=
    STICK_TO_BOTTOM_SLACK_PX
  );
}

const ACTIVE_CHAT_ATTACHMENT_STATUSES = new Set([
  "requesting",
  "accepted",
  "queued",
  "running",
]);

export function chatAttachmentIsActive(status: string, errorCode?: string | null): boolean {
  return ACTIVE_CHAT_ATTACHMENT_STATUSES.has(status) && errorCode !== "provider_outcome_unknown";
}

export function ChatSessionClient({ id }: Readonly<{ id: string }>) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [title, setTitle] = useState("Chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadState, setLoadState] = useState<ChatLoadState>("loading");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const { openReport, reportDialog } = useReportDialog(setStatus);
  const [upgradeReason, setUpgradeReason] = useState<ChatUpgradeReason | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [canUpdateIdentity, setCanUpdateIdentity] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryPending, setMemoryPending] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [voicePreparingIds, setVoicePreparingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [voicePlayingId, setVoicePlayingId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingPending, setEditingPending] = useState(false);
  const [stoppingReply, setStoppingReply] = useState(false);
  const [deleteConfirmMessageId, setDeleteConfirmMessageId] = useState<string | null>(null);
  const [variationPendingMediaId, setVariationPendingMediaId] =
    useState<string | null>(null);
  const [retryingImageIds, setRetryingImageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [jumpToLatestVisible, setJumpToLatestVisible] = useState(false);
  const localStreamStateRef = useRef<Map<string, LocalStreamState>>(new Map());
  const pinnedToBottomRef = useRef(true);
  const sendIntentRef = useRef<{
    sessionId: string;
    content: string;
    idempotencyKey: string;
  } | null>(null);
  const variationIdempotencyKeysRef =
    useRef<Map<string, string>>(new Map());
  const imageRetryKeysRef = useRef<Map<string, string>>(new Map());
  const imageRetryPendingRef = useRef(new Set<string>());
  const streamSources = useRef<Map<string, EventSource>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voicePlaybackIntentRef = useRef(0);
  const voiceClipRequestsRef =
    useRef<Map<string, { key: string; promise: Promise<VoiceClipRequestResult> }>>(new Map());
  const voiceClipUrlsRef = useRef<Map<string, { key: string; url: string }>>(new Map());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const sessionMutationEpochRef = useRef(0);
  const hasActiveAttachment = messages.some((message) =>
    (message.attachments ?? []).some((attachment) =>
      chatAttachmentIsActive(attachment.status, attachment.errorCode),
    ),
  );
  const hasGeneratingReply = chatStreamMessagesNeedReconciliation(messages);
  const canSend = canSubmitChatMessage(
    content,
    pending || stoppingReply,
    hasGeneratingReply,
  );

  useEffect(() => {
    const onScroll = () => {
      pinnedToBottomRef.current = chatViewIsPinnedToBottom(chatViewportMetrics());
      if (pinnedToBottomRef.current) setJumpToLatestVisible(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // SPEC: Keep the newest message (and its streaming deltas) in view; without this
  //       the reply renders below the fold and the input is pushed off-screen.
  // INTENT: a reader who scrolled up keeps their place and gets a jump control
  //         instead; smooth scrolling is dropped mid-stream because per-token
  //         animations restart each other and never settle.
  useEffect(() => {
    if (!pinnedToBottomRef.current) {
      setJumpToLatestVisible(true);
      return;
    }
    messagesEndRef.current?.scrollIntoView({
      behavior: hasGeneratingReply ? "auto" : "smooth",
      block: "end",
    });
    // Streaming state is derived from messages; re-running per token is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (!ageGateAccepted) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      for (const source of streamSources.current.values()) source.close();
      streamSources.current.clear();
      localStreamStateRef.current.clear();
      pinnedToBottomRef.current = true;
      setJumpToLatestVisible(false);
      audioRef.current?.pause();
      audioRef.current = null;
      voicePlaybackIntentRef.current += 1;
      voiceClipRequestsRef.current.clear();
      voiceClipUrlsRef.current.clear();
      setVoicePreparingIds(new Set());
      setVoicePlayingId(null);
      sessionMutationEpochRef.current += 1;
      variationIdempotencyKeysRef.current.clear();
      imageRetryKeysRef.current.clear();
      imageRetryPendingRef.current.clear();
      setRetryingImageIds(new Set());
      setVariationPendingMediaId(null);
      setTitle("Chat");
      setMessages([]);
      setLoadState("loading");
      setStatus(null);
      setCharacterId(null);
      setCanUpdateIdentity(false);
      fetchSession(controller.signal)
        .then((session) => {
          if (cancelled || session.id !== id) return;
          applySession(session);
          resumePendingStreams(session.messages);
          setLoadState("ready");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setLoadState(isChatAuthError(error) ? "signed-out" : "error");
          setStatus(null);
        });
    }, 0);
    return () => {
      cancelled = true;
      sessionMutationEpochRef.current += 1;
      controller.abort();
      window.clearTimeout(timer);
    };
    // The loader intentionally reruns only when the route session id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ageGateAccepted, id]);

  useEffect(() => {
    const sources = streamSources.current;
    return () => {
      for (const source of sources.values()) source.close();
      sources.clear();
      audioRef.current?.pause();
      audioRef.current = null;
      voicePlaybackIntentRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!ageGateAccepted) return;
    if (
      (!hasActiveAttachment && !hasGeneratingReply) ||
      pending ||
      editingPending ||
      memoryPending
    ) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let failureCount = 0;

    const schedule = (delay: number) => {
      if (cancelled) return;
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (cancelled) return;
      if (document.hidden) {
        schedule(2_000);
        return;
      }
      controller = new AbortController();
      const mutationEpoch = sessionMutationEpochRef.current;
      try {
        const session = await fetchSession(controller.signal);
        if (
          cancelled ||
          session.id !== id ||
          mutationEpoch !== sessionMutationEpochRef.current
        ) {
          return;
        }
        applySession(session);
        resumePendingStreams(session.messages);
        failureCount = 0;
        if (chatStreamLatestReplyFailed(session.messages)) {
          setStatus("Reply failed to load. Please try again.");
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
          schedule(Math.min(12_000, 1_500 * 2 ** failureCount));
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden || cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      schedule(0);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(1_500);
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
    editingPending,
    hasActiveAttachment,
    hasGeneratingReply,
    id,
    memoryPending,
    pending,
  ]);

  function stopVoice() {
    voicePlaybackIntentRef.current += 1;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    audioRef.current = null;
    setVoicePlayingId(null);
  }

  async function requestVoiceClip(
    messageId: string,
    text: string,
  ): Promise<VoiceClipRequestResult> {
    // INVARIANT: a regenerated Turn keeps its message id but changes its text
    // and attempt. Its audio must never come from the discarded reply.
    const key = JSON.stringify([id, messages.find((message) => message.id === messageId)?.attempt, text]);
    const cachedClip = voiceClipUrlsRef.current.get(messageId);
    if (cachedClip?.key === key) return { url: cachedClip.url, reason: null };
    const existingRequest = voiceClipRequestsRef.current.get(messageId);
    if (existingRequest?.key === key) return existingRequest.promise;

    setVoicePreparingIds((current) => new Set(current).add(messageId));
    const request = (async (): Promise<VoiceClipRequestResult> => {
      try {
        const response = await fetch("/api/v1/generation/voice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            characterId,
            messageId,
            sessionId: id,
            text,
            intent: "play",
          }),
        });
        if (response.status === 402) {
          const payload = await response.json().catch(() => null);
          return { url: null, reason: voicePaymentRequiredReason(payload) };
        }
        if (!response.ok) return { url: null, reason: "failed" };
        const payload = (await response.json()) as {
          data?: {
            contentUrl?: string;
            reason?: "allowance_exhausted" | "disabled" | "not_entitled";
          };
        };
        const url = payload.data?.contentUrl;
        if (url) {
          if (voiceClipRequestsRef.current.get(messageId)?.key === key) {
            voiceClipUrlsRef.current.set(messageId, { key, url });
          }
          return { url, reason: null };
        }
        return {
          url: null,
          reason: payload.data?.reason ?? "failed",
        };
      } catch {
        return { url: null, reason: "failed" };
      }
    })().finally(() => {
      if (voiceClipRequestsRef.current.get(messageId)?.key !== key) return;
      voiceClipRequestsRef.current.delete(messageId);
      setVoicePreparingIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    });
    voiceClipRequestsRef.current.set(messageId, { key, promise: request });
    return request;
  }

  // SPEC: Voice synthesis starts only after the reader presses Play. Repeated
  // plays of the same selected reply reuse its clip.
  async function playMessage(messageId: string, text: string) {
    if (!characterId || !text.trim()) return;
    if (voicePlayingId === messageId) {
      stopVoice();
      return;
    }
    stopVoice();
    const playbackIntent = voicePlaybackIntentRef.current;
    setStatus(null);
    setUpgradeReason(null);
    try {
      const result = await requestVoiceClip(messageId, text);
      if (playbackIntent !== voicePlaybackIntentRef.current) return;
      if (result.reason === "not_entitled") {
        setUpgradeReason("voice");
        setStatus("Voice playback needs a plan with voice enabled.");
        return;
      }
      if (result.reason === "insufficient_balance") {
        setUpgradeReason("dreamcoins");
        setStatus("Voice playback needs more dreamcoins.");
        return;
      }
      if (!result.url) {
        setStatus("Voice playback failed. Please try again.");
        return;
      }
      const clipKey = voiceClipUrlsRef.current.get(messageId)?.key;
      const audio = new Audio(result.url);
      audioRef.current = audio;
      audio.onended = () => {
        if (playbackIntent !== voicePlaybackIntentRef.current) return;
        setVoicePlayingId((current) => (current === messageId ? null : current));
      };
      audio.onerror = () => {
        if (playbackIntent !== voicePlaybackIntentRef.current) return;
        const cached = voiceClipUrlsRef.current.get(messageId);
        // A deleted/unreadable clip must be revalidated on the next explicit
        // Play. An old player's error must never evict a replacement clip.
        if (cached?.key === clipKey && cached?.url === result.url) {
          voiceClipUrlsRef.current.delete(messageId);
        }
        setStatus("Voice playback failed. Please try again.");
        setVoicePlayingId((current) => (current === messageId ? null : current));
      };
      await audio.play();
      if (playbackIntent !== voicePlaybackIntentRef.current) return;
      setVoicePlayingId(messageId);
    } catch {
      if (playbackIntent !== voicePlaybackIntentRef.current) return;
      setStatus("Voice playback failed. Please try again.");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!canSubmitChatMessage(text, pending, hasGeneratingReply)) return;
    setStatus(null);
    setUpgradeReason(null);
    setContent("");
    setPending(true);
    sessionMutationEpochRef.current += 1;
    // SPEC: Render the reader's own turn before the round-trip resolves — on a
    //       phone the POST costs a full reply latency, and an input that empties
    //       into nothing reads as a dropped message.
    const localMessageId = `${LOCAL_CHAT_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`;
    const dropOptimisticMessage = (current: ChatMessage[]) =>
      current.filter((message) => message.id !== localMessageId);
    setMessages((current) => [
      ...current,
      { id: localMessageId, role: "user", content: text },
    ]);
    const previousIntent = sendIntentRef.current;
    const intent =
      previousIntent?.sessionId === id && previousIntent.content === text
        ? previousIntent
        : {
            sessionId: id,
            content: text,
            idempotencyKey: crypto.randomUUID(),
          };
    sendIntentRef.current = intent;
    try {
      const response = await fetch(`/api/v1/chat/sessions/${id}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intent.idempotencyKey,
        },
        body: JSON.stringify({ content: text }),
      });
      // Quota exhausted: keep the user's input and surface the upgrade path (P0-C).
      if (response.status === 402) {
        setUpgradeReason("messages");
        setStatus("Daily free message limit reached.");
        setContent(text);
        setMessages(dropOptimisticMessage);
        return;
      }
      if (!response.ok) {
        setStatus(chatFailureCopy(
          await response.json().catch(() => null),
          "Message failed to send. Please try again.",
        ));
        setContent(text);
        setMessages(dropOptimisticMessage);
        return;
      }
      const payload = parseChatSendResponse(await response.json());
      const userMessage = payload.userMessage;
      const assistant = payload.assistant;
      const streamUrl = payload.streamUrl;
      sendIntentRef.current = null;

      // Blocked input (P0-B): the assistant turn is a terminal safety notice with no
      // stream. Render it in place; do NOT open an EventSource that would never fill.
      if (assistant.status === "blocked" || !streamUrl) {
        setMessages((current) =>
          mergeCanonicalMessages(dropOptimisticMessage(current), [
            userMessage,
            assistant,
          ]),
        );
        if (assistant.status === "blocked") {
          setStatus("That message was blocked by our safety policy.");
        }
      } else {
        setMessages((current) =>
          mergeCanonicalMessages(dropOptimisticMessage(current), [
            userMessage,
            { ...assistant, content: "" },
          ]),
        );
        if (assistant.status === "generating") {
          streamAssistant(streamUrl, assistant.id, assistant.content);
        }
      }
    } catch {
      // Network/parse failure: surface the error and restore the typed text so the
      // user's message is never silently lost (P0 — silent message loss).
      setStatus("Message failed to send. Please try again.");
      setContent(text);
      setMessages(dropOptimisticMessage);
    } finally {
      setPending(false);
    }
  }

  function reportMessage(messageId: string) {
    setStatus(null);
    setDeleteConfirmMessageId(null);
    openReport({ kind: "record", targetType: "chat_message", targetId: messageId });
  }

  function beginEdit(message: ChatMessage) {
    setStatus(null);
    setDeleteConfirmMessageId(null);
    setEditingMessageId(message.id);
    setEditingContent(message.content);
  }

  function cancelEdit() {
    setEditingMessageId(null);
    setEditingContent("");
  }

  async function saveEditedMessage(messageId: string) {
    const next = editingContent.trim();
    if (!next || editingPending) return;
    setStatus(null);
    setDeleteConfirmMessageId(null);
    setUpgradeReason(null);
    setEditingPending(true);
    stopVoice();
    sessionMutationEpochRef.current += 1;
    try {
      const response = await fetch(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: next }),
      });
      if (response.status === 402) {
        setUpgradeReason("messages");
        setStatus("Daily free message limit reached.");
        return;
      }
      if (!response.ok) {
        setStatus(chatFailureCopy(
          await response.json().catch(() => null),
          "Couldn't edit the message. Please try again.",
        ));
        return;
      }
      const payload = (await response.json()) as {
        assistantMessageId?: string;
        streamUrl?: string | null;
        status?: "pending" | "generating" | "blocked";
      };
      if (payload.assistantMessageId) {
        localStreamStateRef.current.delete(payload.assistantMessageId);
      }
      cancelEdit();
      const session = await fetchSession();
      applySession(session);
      if (payload.status === "blocked" || !payload.streamUrl) {
        if (payload.status === "blocked") {
          setStatus("That message was blocked by our safety policy.");
        }
        return;
      }
      if (!payload.assistantMessageId) {
        setStatus("Couldn't edit the message. Please try again.");
        return;
      }
      if (payload.status === "generating") {
        streamAssistant(payload.streamUrl, payload.assistantMessageId, "");
      }
    } catch {
      setStatus("Couldn't edit the message. Please try again.");
    } finally {
      setEditingPending(false);
    }
  }

  async function fetchSession(signal?: AbortSignal): Promise<ChatSession> {
    const response = await fetch(`/api/v1/chat/sessions/${id}`, {
      cache: "no-store",
      signal,
    });
    if (response.status === 401) throw chatSessionFetchError(401);
    if (!response.ok) throw new Error("Chat unavailable");
    const session = parseChatSessionDetailResponse(
      await response.json(),
    ).session;
    if (session.id !== id) throw new Error("Chat unavailable");
    return session;
  }

  function applySession(session: ChatSession) {
    if (session.id !== id) return;
    let recoveredStream = false;
    for (const message of session.messages) {
      if (!chatStreamMessageIsTerminal(message)) continue;
      if (message.status !== STOPPED_REPLY_STATUS) localStreamStateRef.current.delete(message.id);
      const source = streamSources.current.get(message.id);
      if (!source) continue;
      source.close();
      streamSources.current.delete(message.id);
      recoveredStream = true;
    }
    if (recoveredStream) setStatus(null);
    // 角色行可能已经不存在了（创作者注销会硬删他的角色，且不通知 chat）。
    // BFF 在那种情况下把 name 兜成空串，直接用会渲染出一个无名会话头。
    setTitle(session.title || session.character.name || "Unavailable character");
    setMessages((current) => [
      ...applyLocalStreamState(session.messages, localStreamStateRef.current),
      // An optimistic turn is not in the session yet; a poll or a recovery read
      // must not make the reader's own message disappear mid-send.
      ...current.filter((message) => isLocalChatMessageId(message.id)),
    ]);
    setDeleteConfirmMessageId(null);
    if (session.characterId) setCharacterId(session.characterId);
    setCanUpdateIdentity(Boolean(session.character.canUpdateIdentity));
    if (typeof session.memoryEnabled === "boolean") setMemoryEnabled(session.memoryEnabled);
  }

  // SPEC: Flip long-term memory for this session; optimistic, reconciled from the
  //       updated session row the BFF returns (raw, not {ok,data}).
  async function toggleMemory() {
    if (memoryPending) return;
    setStatus(null);
    setDeleteConfirmMessageId(null);
    const next = !memoryEnabled;
    setMemoryPending(true);
    sessionMutationEpochRef.current += 1;
    try {
      const response = await fetch(`/api/v1/chat/sessions/${id}/memory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoryEnabled: next }),
      });
      if (!response.ok) {
        setStatus("Couldn't update memory. Please try again.");
        return;
      }
      const row = (await response.json()) as { memoryEnabled?: boolean };
      setMemoryEnabled(typeof row.memoryEnabled === "boolean" ? row.memoryEnabled : next);
    } catch {
      setStatus("Couldn't update memory. Please try again.");
    } finally {
      setMemoryPending(false);
    }
  }

  async function deleteMessage(messageId: string) {
    setStatus(null);
    if (deleteConfirmMessageId !== messageId) {
      setDeleteConfirmMessageId(messageId);
      setStatus("Press Confirm delete to remove your message and the reply.");
      return;
    }
    stopVoice();
    sessionMutationEpochRef.current += 1;
    try {
      const response = await fetch(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
      });
      if (response.ok) {
        // INVARIANT: Main deletes one complete Turn from either message id.
        const target = messages.find((message) => message.id === messageId);
        const userMessageId = target?.role === "user" ? target.id : target?.replyToMessageId;
        for (const message of messages) {
          if (message.id !== messageId && message.id !== userMessageId && message.replyToMessageId !== userMessageId) continue;
          localStreamStateRef.current.delete(message.id);
          voiceClipUrlsRef.current.delete(message.id);
          voiceClipRequestsRef.current.delete(message.id);
        }
        setMessages((current) => current.filter((message) =>
          message.id !== messageId &&
          message.id !== userMessageId &&
          message.replyToMessageId !== userMessageId,
        ));
        setDeleteConfirmMessageId(null);
      } else {
        setStatus(chatFailureCopy(
          await response.json().catch(() => null),
          "Couldn't delete the message. Please try again.",
        ));
        setDeleteConfirmMessageId(null);
      }
    } catch {
      setStatus("Couldn't delete the message. Please try again.");
      setDeleteConfirmMessageId(null);
    }
  }

  async function retryImageAttachment(attachment: ChatAttachment) {
    const jobId = attachment.generationJobId;
    if (!jobId || imageRetryPendingRef.current.has(attachment.id)) return;
    imageRetryPendingRef.current.add(attachment.id);
    setRetryingImageIds(new Set(imageRetryPendingRef.current));
    setStatus(null);
    setDeleteConfirmMessageId(null);
    const epoch = ++sessionMutationEpochRef.current;
    try {
      let quoteAuthority;
      if (!hasUnconfirmedGenerationRetry(jobId, imageRetryKeysRef.current)) {
        const response = await fetch(`/api/v1/generation/jobs/${encodeURIComponent(jobId)}/retry/quote`, { method: "POST", cache: "no-store" });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new GenerationRequestError(chatFailureCopy(payload, "Couldn't check the image retry price."), response.status);
        const { quote } = parseGenerationRetryQuoteResponse(payload);
        quoteAuthority = { profileId: quote.profileId, profileVersion: quote.profileVersion, routeFingerprint: quote.routeFingerprint, pricingFingerprint: quote.pricing.fingerprint, outputCount: quote.outputCount, costDreamcoins: quote.costDreamcoins };
      }
      if (epoch !== sessionMutationEpochRef.current) return;
      const job = await requestGenerationRetryWithExactAuthority({ jobId, quoteAuthority, idempotencyKeys: imageRetryKeysRef.current });
      if (epoch !== sessionMutationEpochRef.current) return;
      setMessages(current => current.map(message => ({ ...message, attachments: message.attachments?.map(item => item.id === attachment.id
        ? { ...item, generationJobId: job.id, status: "accepted", errorCode: null, costDreamcoins: job.costDreamcoins }
        : item) })));
      const session = await fetchSession();
      if (epoch === sessionMutationEpochRef.current && session.id === id) applySession(session);
    } catch (error) {
      if (epoch !== sessionMutationEpochRef.current) return;
      if (error instanceof GenerationRequestError && error.status === 402) setUpgradeReason("dreamcoins");
      setStatus(error instanceof GenerationRequestError ? error.message : "Couldn't confirm the image request. Try again to check the same request.");
    } finally {
      imageRetryPendingRef.current.delete(attachment.id);
      setRetryingImageIds(new Set(imageRetryPendingRef.current));
    }
  }

  async function addAttachmentToIdentity(mediaAssetId: string) {
    setStatus(null);
    setDeleteConfirmMessageId(null);
    try {
      const response = await fetch(`/api/v1/media/${encodeURIComponent(mediaAssetId)}/add-to-identity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(characterId ? { characterId } : {}),
      });
      setStatus(response.ok ? "Added image to this character's identity." : "Couldn't update identity.");
    } catch {
      setStatus("Couldn't update identity.");
    }
  }

  async function recordAttachmentIdentityFeedback(
    mediaAssetId: string,
    feedbackType: "identity_match" | "identity_mismatch",
  ) {
    setStatus(null);
    try {
      const response = await fetch(`/api/v1/media/${encodeURIComponent(mediaAssetId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedbackType, sourceSurface: "chat" }),
      });
      setStatus(
        response.ok
          ? feedbackType === "identity_match"
            ? "Thanks — this image looks like the character."
            : "Identity mismatch recorded. Use More like this for a corrected retry."
          : "Couldn't save image feedback.",
      );
    } catch {
      setStatus("Couldn't save image feedback.");
    }
  }

  async function createAttachmentVariation(mediaAssetId: string) {
    if (variationPendingMediaId === mediaAssetId) return;
    setVariationPendingMediaId(mediaAssetId);
    setStatus("Checking the exact variation price…");
    setDeleteConfirmMessageId(null);
    try {
      await requestMediaVariationWithExactQuote({
        mediaId: mediaAssetId,
        outputCount: 1,
        consistencyMode: "balanced",
        idempotencyKeys: variationIdempotencyKeysRef.current,
      });
      setStatus("Variation queued. It will appear in Generate and Gallery.");
    } catch (error) {
      setStatus(
        error instanceof GenerationRequestError
          ? error.message
          : "Couldn't queue variation. Check your connection and try again.",
      );
    } finally {
      setVariationPendingMediaId((current) =>
        current === mediaAssetId ? null : current,
      );
    }
  }

  // SPEC: Regenerate keeps the assistant message identity and advances its
  // attempt. Discard the old stream cache before displaying the new attempt.
  async function regenerate(messageId: string) {
    if (pending || hasGeneratingReply) return;
    setPending(true);
    stopVoice();
    setStatus(null);
    setDeleteConfirmMessageId(null);
    sessionMutationEpochRef.current += 1;
    try {
      const response = await fetch(
        `/api/v1/messages/${encodeURIComponent(messageId)}/regenerate`,
        { method: "POST" },
      );
      if (!response.ok) {
        setStatus(chatFailureCopy(
          await response.json().catch(() => null),
          "Couldn't regenerate. Please try again.",
        ));
        return;
      }
      const payload = (await response.json()) as {
        assistantMessageId?: string;
        attempt?: number;
        streamUrl?: string | null;
        status?: "pending" | "generating";
      };
      const newId = payload.assistantMessageId;
      const streamUrl = payload.streamUrl;
      if (!newId || !streamUrl) {
        setStatus("Couldn't regenerate. Please try again.");
        return;
      }
      localStreamStateRef.current.delete(messageId);
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, id: newId, attempt: payload.attempt, content: "", status: payload.status ?? "pending" }
            : message,
        ),
      );
      if (payload.status === "generating") streamAssistant(streamUrl, newId, "");
    } catch {
      setStatus("Couldn't regenerate. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function resumePendingStreams(loadedMessages: ChatMessage[]) {
    for (const message of loadedMessages) {
      if (
        message.role === "assistant" &&
        !message.content.trim() &&
        message.status === "generating"
      ) {
        const attempt = Number.isSafeInteger(message.attempt) && Number(message.attempt) > 0
          ? `?attempt=${message.attempt}`
          : "";
        streamAssistant(
          `/api/v1/chat/messages/${encodeURIComponent(message.id)}/stream${attempt}`,
          message.id,
          "",
        );
      }
    }
  }

  function streamAssistant(streamUrl: string, assistantId: string, fallback: string) {
    if (streamSources.current.has(assistantId)) return;

    let streamed = "";
    let finished = false;
    const source = new EventSource(streamUrl);
    streamSources.current.set(assistantId, source);
    localStreamStateRef.current.set(assistantId, { content: "", stopped: false });

    const close = () => {
      source.close();
      // A late recovery from the previous attempt must not close the newer
      // EventSource registered under the same durable assistant message id.
      if (streamSources.current.get(assistantId) !== source) return;
      streamSources.current.delete(assistantId);
      if (!localStreamStateRef.current.get(assistantId)?.stopped) {
        localStreamStateRef.current.delete(assistantId);
      }
    };

    const finish = async () => {
      if (finished) return;
      finished = true;
      const mutationEpoch = sessionMutationEpochRef.current;
      if (!streamed && fallback) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, content: fallback } : message,
          ),
        );
      }
      const outcome = await recoverAssistantFromSession(assistantId);
      if (mutationEpoch !== sessionMutationEpochRef.current) return;
      if (!streamed && !fallback && outcome === "terminal_empty") {
        setMessages((current) => current.filter((message) => message.id !== assistantId));
        setStatus("Reply failed to load. Please try again.");
      }
    };

    source.addEventListener("delta", (event) => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      const data = parseStreamEvent(event);
      const delta = typeof data.delta === "string" ? data.delta : "";
      streamed += delta;
      localStreamStateRef.current.set(assistantId, {
        content: streamed,
        stopped: false,
      });
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, content: streamed } : message,
        ),
      );
    });

    source.addEventListener("replace", (event) => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      const data = parseStreamEvent(event);
      streamed = typeof data.content === "string" ? data.content : "";
      localStreamStateRef.current.set(assistantId, {
        content: streamed,
        stopped: false,
      });
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, content: streamed } : message,
        ),
      );
    });

    source.addEventListener("done", () => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      setStatus(null);
      void finish().finally(close);
    });

    source.addEventListener("error", (event) => {
      if (finished || streamSources.current.get(assistantId) !== source) return;
      const payload = parseStreamEvent(event);
      if (chatStreamErrorDisposition(payload) === "reconnect") {
        setStatus("Reply interrupted. Reconnecting…");
        return;
      }
      finished = true;
      const mutationEpoch = sessionMutationEpochRef.current;
      const terminalMessage = chatStreamTerminalErrorMessage(payload);
      void recoverAssistantFromSession(assistantId).finally(() => {
        if (mutationEpoch === sessionMutationEpochRef.current) setStatus(terminalMessage);
        close();
      });
    });
  }

  // SPEC: Stop is a Chat-owned terminal transition. The browser closes SSE
  // immediately, but unlocks the composer only after Chat has cancelled the
  // exact durable attempt and signalled the active DSH invocation.
  async function stopStreamingReply() {
    if (stoppingReply) return;
    sessionMutationEpochRef.current += 1;
    const stoppedIds = new Set<string>();
    for (const [messageId, source] of streamSources.current) {
      source.close();
      stoppedIds.add(messageId);
    }
    streamSources.current.clear();
    for (const message of messages) {
      if (chatStreamMessageIsInProgress(message)) stoppedIds.add(message.id);
    }
    if (stoppedIds.size === 0) return;
    setStoppingReply(true);
    setStatus("Stopping reply…");
    let completionWonRace = false;
    const results = await Promise.all(
      [...stoppedIds].map(async (messageId) => {
        const response = await fetch(
          `/api/v1/messages/${encodeURIComponent(messageId)}/cancel`,
          { method: "POST" },
        );
        if (response.ok) {
          const result = await response.json() as { cancelled?: boolean };
          completionWonRace ||= result.cancelled === false;
        }
        return response.ok;
      }),
    ).catch(() => stoppedIds.size === 0 ? [] : [false]);
    if (!results.every(Boolean) || completionWonRace) {
      for (const messageId of stoppedIds) {
        localStreamStateRef.current.delete(messageId);
      }
      setStatus(completionWonRace ? null : "Couldn't stop the reply. Reconnecting…");
      try {
        const session = await fetchSession();
        applySession(session);
        resumePendingStreams(session.messages);
      } catch {
        // Keep the explicit reconnecting state; the normal poll loop remains
        // the recovery path when this immediate authority read also fails.
      } finally {
        setStoppingReply(false);
      }
      return;
    }
    for (const messageId of stoppedIds) {
      const streamedContent = localStreamStateRef.current.get(messageId)?.content;
      localStreamStateRef.current.set(messageId, {
        content:
          streamedContent ??
          messages.find((message) => message.id === messageId)?.content ??
          "",
        stopped: true,
      });
    }
    setMessages((current) =>
      applyLocalStreamState(current, localStreamStateRef.current),
    );
    setStatus("Reply stopped. Regenerate for a new one.");
    setStoppingReply(false);
  }

  function jumpToLatest() {
    pinnedToBottomRef.current = true;
    setJumpToLatestVisible(false);
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  async function recoverAssistantFromSession(assistantId: string) {
    const mutationEpoch = sessionMutationEpochRef.current;
    return reconcileChatStreamAuthority({
      apply: (session) => {
        if (mutationEpoch === sessionMutationEpochRef.current) applySession(session);
      },
      assistantId,
      messages: (session: ChatSession) => session.messages,
      read: () => fetchSession(),
      wait: () => new Promise((resolve) => window.setTimeout(resolve, 500)),
    });
  }

  const latestUserMessageId = newestUserMessageId(messages);
  const latestReplyInProgress = replyAfterLatestUserInProgress(messages);

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref="/chat" />
        <section className="flex min-w-0 flex-1 flex-col px-4 py-6 pb-24 md:px-[60px]">
          <Link
            className="mb-5 inline-flex items-center gap-2 text-[13px] font-bold text-[rgb(170,170,170)] hover:text-white"
            href="/"
          >
            <ArrowLeft className="h-4 w-4" />
            Explore
          </Link>
          <h1 className="text-[32px] font-black uppercase leading-9">{title}</h1>
          {loadState === "ready" ? (
            <>
              <ChatHeaderControls
                characterId={characterId}
                memoryEnabled={memoryEnabled}
                memoryPending={memoryPending}
                onToggleMemory={toggleMemory}
                onOpenSessions={() => setSessionsOpen(true)}
                onOpenMemory={() => setMemoryOpen(true)}
              />
              <ConversationPreferences key={id} sessionId={id} />
              <div className="mt-6 flex min-h-[55vh] flex-1 flex-col gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
                {messages.map((message) => {
                  const isUser = message.role === "user";
                  const immutableOpening = isImmutableOpeningMessage(message);
                  const replyInProgress = chatStreamMessageIsInProgress(message);
                  const isEditing = editingMessageId === message.id;
                  const messageDeleteConfirm = deleteConfirmMessageId === message.id;
                  const showMessageActions =
                    !isEditing &&
                    !replyInProgress &&
                    !isLocalChatMessageId(message.id);
                  const canEditMessage =
                    isUser &&
                    message.id === latestUserMessageId &&
                    !latestReplyInProgress;
                  const canRegenerateMessage =
                    !immutableOpening &&
                    message.replyToMessageId === latestUserMessageId &&
                    canRegenerateChatMessage(message, hasGeneratingReply);
                  const canDeleteMessage =
                    !immutableOpening &&
                    !latestReplyInProgress &&
                    (message.id === latestUserMessageId ||
                      message.replyToMessageId === latestUserMessageId);
                  const canPlayMessage = !isUser && message.status === "sent" && Boolean(message.content.trim());
                  const messageActionCount = showMessageActions
                    ? 1 +
                      Number(canDeleteMessage) +
                      Number(canEditMessage) +
                      Number(canRegenerateMessage) +
                      Number(canPlayMessage)
                    : 0;
                  const actionPaddingClass = chatMessageActionPaddingClass(
                    messageActionCount,
                    messageDeleteConfirm,
                  );
                  return (
                    <div
                      aria-busy={!isUser && replyInProgress}
                      aria-label={isUser ? "Your message" : "Assistant message"}
                      className={`group relative max-w-[78%] rounded-[16px] px-4 py-3 text-[14px] leading-6 ${actionPaddingClass} ${
                        isUser
                          ? "ml-auto bg-white text-[rgb(13,13,13)]"
                          : "bg-[rgb(36,36,36)] text-white"
                      }`}
                      data-message-id={message.id}
                      data-testid={`chat-message-${message.role}`}
                      key={message.id}
                    >
                      {isEditing ? (
                        <form
                          className="space-y-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveEditedMessage(message.id);
                          }}
                        >
                          <label className="sr-only" htmlFor={`edit-${message.id}`}>
                            Edit message
                          </label>
                          <textarea
                            className="min-h-24 w-full resize-y rounded-[12px] border border-black/10 bg-white/80 p-3 text-[14px] font-medium text-[rgb(13,13,13)] outline-none focus:border-[rgb(253,95,194)]"
                            data-testid="chat-edit-input"
                            disabled={editingPending}
                            id={`edit-${message.id}`}
                            onChange={(event) => setEditingContent(event.target.value)}
                            value={editingContent}
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="inline-flex h-9 items-center gap-2 rounded-full bg-[rgb(13,13,13)] px-3 text-[12px] font-black uppercase text-white disabled:opacity-50"
                              data-testid="chat-save-edit"
                              disabled={editingPending || !editingContent.trim()}
                              type="submit"
                            >
                              {editingPending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                              Save
                            </button>
                            <button
                              className="inline-flex h-9 items-center gap-2 rounded-full bg-black/10 px-3 text-[12px] font-black uppercase text-[rgb(13,13,13)]"
                              data-testid="chat-cancel-edit"
                              disabled={editingPending}
                              onClick={cancelEdit}
                              type="button"
                            >
                              <X className="h-3.5 w-3.5" />
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : !isUser && message.status === "blocked" && !message.content.trim() ? (
                        BLOCKED_ASSISTANT_NOTICE
                      ) : !isUser && replyInProgress ? (
                        <>
                          {message.content}
                          <span
                            aria-label="Assistant is typing"
                            className={`inline-flex items-center gap-1 py-0.5 ${message.content.trim() ? "ml-2" : ""}`}
                            role="status"
                          >
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:-0.3s] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-delay:-0.15s] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/60 [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none" />
                          </span>
                        </>
                      ) : !isUser && !message.content.trim() ? (
                        <span aria-label="Assistant reply unavailable" role="status">
                          {message.status === STOPPED_REPLY_STATUS
                            ? "Reply stopped."
                            : "Reply unavailable."}
                        </span>
                      ) : (
                        message.content
                      )}
                      {(message.attachments ?? []).length > 0 ? (
                        <div className="mt-3 space-y-2">
                          {message.attachments?.map((attachment) => (
                            <ChatImageAttachmentCard
                              attachment={attachment}
                              canAddToIdentity={canUpdateIdentity}
                              characterId={characterId}
                              key={attachment.id}
                              paymentHref={upgradeHrefForChatSession(id)}
                              onAddToIdentity={
                                attachment.mediaAssetId
                                  ? () => addAttachmentToIdentity(attachment.mediaAssetId as string)
                                  : undefined
                              }
                              onRetry={() => retryImageAttachment(attachment)}
                              retryPending={retryingImageIds.has(attachment.id)}
                              onIdentityMatch={
                                attachment.mediaAssetId
                                  ? () => recordAttachmentIdentityFeedback(attachment.mediaAssetId as string, "identity_match")
                                  : undefined
                              }
                              onIdentityMismatch={
                                attachment.mediaAssetId
                                  ? () => recordAttachmentIdentityFeedback(attachment.mediaAssetId as string, "identity_mismatch")
                                  : undefined
                              }
                              onMoreLikeThis={
                                attachment.mediaAssetId
                                  ? () => createAttachmentVariation(attachment.mediaAssetId as string)
                                  : undefined
                              }
                              moreLikeThisPending={
                                attachment.mediaAssetId ===
                                variationPendingMediaId
                              }
                            />
                          ))}
                        </div>
                      ) : null}
                      {showMessageActions ? (
                        <MessageActions
                          isUser={isUser}
                          pending={pending || editingPending}
                          voiceState={
                            voicePreparingIds.has(message.id)
                              ? "loading"
                              : voicePlayingId === message.id
                                ? "playing"
                                : undefined
                          }
                          onEdit={
                            canEditMessage
                              ? () => beginEdit(message)
                              : undefined
                          }
                          onReport={() => reportMessage(message.id)}
                          onDelete={canDeleteMessage ? () => deleteMessage(message.id) : undefined}
                          deleteConfirm={canDeleteMessage && messageDeleteConfirm}
                          onRegenerate={
                            canRegenerateMessage
                              ? () => regenerate(message.id)
                              : undefined
                          }
                          onPlay={
                            canPlayMessage
                              ? () => playMessage(message.id, message.content)
                              : undefined
                          }
                        />
                      ) : null}
                    </div>
                  );
                })}
                {/* Keep auto-follow and New messages above the sticky composer/mobile navigation. */}
                <div className="scroll-mb-40 md:scroll-mb-20" ref={messagesEndRef} />
              </div>
              {jumpToLatestVisible ? (
                <button
                  className="sticky bottom-36 z-10 self-center rounded-full bg-white px-3 py-2 text-[12px] font-bold text-[rgb(13,13,13)] shadow-[0_2px_12px_rgba(0,0,0,0.45)] md:bottom-16"
                  data-testid="chat-jump-to-latest"
                  onClick={jumpToLatest}
                  type="button"
                >
                  <ArrowDown className="mr-1.5 inline h-3.5 w-3.5" />
                  New messages
                </button>
              ) : null}
              <form
                className="sticky bottom-20 z-10 mt-4 flex gap-2 bg-[rgb(13,13,13)] py-2 md:bottom-0"
                onSubmit={submit}
              >
                <input
                  aria-label="Message"
                  className="h-12 min-w-0 flex-1 rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-medium outline-none placeholder:text-[rgb(114,113,112)]"
                  id={`chat-message-${id}`}
                  onChange={(event) => setContent(event.target.value)}
                  name="message"
                  placeholder="Message..."
                  value={content}
                />
                {hasGeneratingReply ? (
                  <button
                    aria-label="Stop reply"
                    className={COMPOSER_BUTTON_CLASS}
                    disabled={stoppingReply}
                    data-testid="chat-stop-reply"
                    onClick={() => void stopStreamingReply()}
                    title="Stop reply"
                    type="button"
                  >
                    {stoppingReply
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Square className="h-4 w-4" />}
                  </button>
                ) : (
                  <button
                    aria-label="Send message"
                    className={COMPOSER_BUTTON_CLASS}
                    disabled={!canSend}
                    type="submit"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                )}
              </form>
              {status ? (
                <p
                  aria-live="polite"
                  className="mt-3 text-[13px] font-semibold text-[#ff7ac8]"
                  data-testid="chat-session-status"
                  role="status"
                >
                  {status}
                  {upgradeReason ? (
                    <>
                      {" "}
                      <Link className="underline hover:text-white" href={upgradeHrefForChatSession(id)}>
                        {chatUpgradeLinkLabel(upgradeReason)}
                      </Link>
                      .
                    </>
                  ) : null}
                </p>
              ) : null}
            </>
          ) : (
            <ChatSessionUnavailablePanel loadState={loadState} sessionId={id} />
          )}
        </section>
      </div>
      <MobileBottomNav activeHref="/chat" />
      <ChatSessionListDrawer
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        currentSessionId={id}
      />
      <MemoryPanel
        key={id}
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        characterId={characterId}
        sessionId={id}
        memoryEnabled={memoryEnabled}
        memoryPending={memoryPending}
        onToggleMemory={toggleMemory}
      />
      {reportDialog}
    </main>
  );
}

function ChatSessionUnavailablePanel({
  loadState,
  sessionId,
}: Readonly<{ loadState: Exclude<ChatLoadState, "ready">; sessionId: string }>) {
  const loginTarget = `/chat/${encodeURIComponent(sessionId)}`;

  if (loadState === "loading") {
    return (
      <div className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center">
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-[rgb(114,113,112)]" />
        <h2 className="mt-4 text-[22px] font-black uppercase text-white">Loading chat</h2>
        <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]" role="status">
          Fetching the latest messages and session controls.
        </p>
      </div>
    );
  }

  if (loadState === "signed-out") {
    return (
      <div
        className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center"
        data-testid="chat-session-auth-required"
      >
        <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
        <h2 className="mt-4 text-[22px] font-black uppercase text-white">
          Log in to continue this chat
        </h2>
        <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
          This conversation is private. Log in to reopen it, or join free to start from your chat
          hub.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link
            className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
            href={authHrefForTarget("/login", loginTarget)}
          >
            Log in
          </Link>
          <Link
            className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
            href={authHrefForTarget("/signup", "/chat")}
          >
            Join free
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center"
      data-testid="chat-session-unavailable"
    >
      <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
      <h2 className="mt-4 text-[22px] font-black uppercase text-white">Chat unavailable</h2>
      <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
        This conversation could not be loaded. Open your chat hub or start a new conversation.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link
          className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
          href="/chat"
        >
          Chat hub
        </Link>
        <Link
          className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
          href="/"
        >
          Explore
        </Link>
      </div>
    </div>
  );
}

function chatViewportMetrics() {
  return {
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  };
}

function chatSessionFetchError(status: number) {
  const error = new Error("Chat session fetch failed") as Error & { status: number };
  error.status = status;
  return error;
}

function isChatAuthError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 401
  );
}

function newestUserMessageId(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.id;
  }
  return null;
}

function replyAfterLatestUserInProgress(messages: ChatMessage[]) {
  const latestUserIndex = findLatestUserMessageIndex(messages);
  if (latestUserIndex < 0) return false;
  return messages
    .slice(latestUserIndex + 1)
    .some(
      (message) =>
        message.role === "assistant" &&
        (message.status === "generating" || message.status === "pending"),
    );
}

function findLatestUserMessageIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function ChatImageAttachmentCard({
  attachment,
  canAddToIdentity,
  characterId,
  onRetry,
  retryPending,
  onAddToIdentity,
  onIdentityMatch,
  onIdentityMismatch,
  onMoreLikeThis,
  moreLikeThisPending,
  paymentHref,
}: Readonly<{
  attachment: ChatAttachment;
  canAddToIdentity: boolean;
  characterId: string | null;
  onRetry: () => void;
  retryPending: boolean;
  onAddToIdentity?: () => void;
  onIdentityMatch?: () => void;
  onIdentityMismatch?: () => void;
  onMoreLikeThis?: () => void;
  moreLikeThisPending: boolean;
  paymentHref: string;
}>) {
  const source = attachment.thumbnailUrl ?? attachment.mediaUrl;
  const previewKey = `${attachment.id}:${source ?? ""}`;
  const [invalidPreviewKey, setInvalidPreviewKey] = useState<string | null>(null);
  const invalidPreview = invalidPreviewKey === previewKey;
  const isLegacyTestAsset = attachment.isSynthetic === true;

  if (attachment.status === "completed" && attachment.mediaUrl && source && !invalidPreview) {
    return (
      // 宽度约束必须在 figure 上：过去只有 <img> 带 max-w，figure 仍撑满气泡宽度，
      // 于是图片右侧露出一大片深色底，操作条也跟着拉宽。同组件的等待/失败分支
      // 本来就是 `w-full max-w-[260px]`，这里只是漏了。
      <figure className="relative w-full max-w-[260px] overflow-hidden rounded-[12px] border border-white/10 bg-black/20">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt="Generated character image from this chat"
          className="aspect-[4/5] w-full object-cover"
          data-asset-id={attachment.mediaAssetId ?? undefined}
          data-testid="chat-image-attachment"
          height={attachment.height ?? 640}
          onError={() => setInvalidPreviewKey(previewKey)}
          onLoad={(event) => {
            if (isInvalidChatImagePreview(event.currentTarget)) setInvalidPreviewKey(previewKey);
          }}
          src={source}
          width={attachment.width ?? 512}
        />
        <LegacyTestAssetBadge isSynthetic={isLegacyTestAsset} />
        {attachment.mediaAssetId ? (
          <ChatImageAttachmentActions
            canAddToIdentity={canAddToIdentity}
            characterId={characterId}
            onAddToIdentity={onAddToIdentity}
            onIdentityMatch={onIdentityMatch}
            onIdentityMismatch={onIdentityMismatch}
            onMoreLikeThis={onMoreLikeThis}
            moreLikeThisPending={moreLikeThisPending}
          />
        ) : null}
      </figure>
    );
  }

  const requiresReview = attachment.errorCode === "provider_outcome_unknown";
  const isWaiting = chatAttachmentIsActive(attachment.status, attachment.errorCode);
  const failed = ["failed", "blocked", "refunded", "rejected"].includes(attachment.status);
  const canRetry = Boolean(attachment.generationJobId) && ["failed", "refunded"].includes(attachment.status);
  const paymentRequired = failed && attachment.errorCode === "payment_required";
  const completedUnavailable = attachment.status === "completed" && Boolean(attachment.mediaAssetId);
  return (
    <div
      className="w-full max-w-[260px] rounded-[12px] border border-white/10 bg-black/20 p-3"
      data-testid="chat-image-attachment-card"
    >
      <div className="flex items-start gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-white">
          {isWaiting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold text-white">
            {requiresReview
              ? "Image result needs review"
              : paymentRequired
                ? "Not enough dreamcoins"
              : failed || attachment.status === "proposed" || completedUnavailable
                ? "Image unavailable"
                : "Generating image"}
          </p>
          {completedUnavailable ? (
            <div
              className="mt-2 flex flex-col items-start gap-1 text-[11px] leading-4 text-white/60"
              data-testid="chat-image-preview-fallback"
            >
              <span className="font-bold text-white/80">Preview unavailable</span>
              <span className="line-clamp-2">
                The image is ready, but its preview could not be loaded.
              </span>
            </div>
          ) : (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-white/60">
              {requiresReview
                ? "The result could not be confirmed. Contact support before trying again."
                : failed || attachment.status === "proposed"
                ? paymentRequired
                  ? "Add dreamcoins to generate this image."
                  : canRetry ? "The image could not be completed. Retry uses the current image price." : "The image could not be completed. You can send a new image request in this chat."
                : "Your image is being prepared. You can keep chatting while it finishes."}
            </p>
          )}
        </div>
      </div>
      {requiresReview ? (
        <div className="mt-3 text-[11px] text-white/70">
          <Link className="underline" href="/helpdesk">Contact support</Link>
          <p className="mt-1 break-all">Request: {attachment.generationJobId ?? attachment.id}</p>
        </div>
      ) : paymentRequired ? (
        <Link
          className="mt-3 inline-flex h-8 items-center rounded-full bg-white px-3 text-[12px] font-bold text-[rgb(13,13,13)]"
          href={paymentHref}
        >
          Get more dreamcoins
        </Link>
      ) : canRetry ? (
        <button
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[12px] font-bold text-[rgb(13,13,13)] disabled:opacity-70"
          disabled={retryPending}
          onClick={onRetry}
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {retryPending ? "Checking image request…" : "Retry image"}
        </button>
      ) : null}
      {completedUnavailable ? (
        <ChatImageAttachmentActions
          canAddToIdentity={canAddToIdentity}
          characterId={characterId}
          onAddToIdentity={onAddToIdentity}
          onIdentityMatch={onIdentityMatch}
          onIdentityMismatch={onIdentityMismatch}
          onMoreLikeThis={onMoreLikeThis}
          moreLikeThisPending={moreLikeThisPending}
        />
      ) : null}
    </div>
  );
}

function ChatImageAttachmentActions({
  canAddToIdentity,
  characterId,
  onAddToIdentity,
  onIdentityMatch,
  onIdentityMismatch,
  onMoreLikeThis,
  moreLikeThisPending,
}: Readonly<{
  canAddToIdentity: boolean;
  characterId: string | null;
  onAddToIdentity?: () => void;
  onIdentityMatch?: () => void;
  onIdentityMismatch?: () => void;
  onMoreLikeThis?: () => void;
  moreLikeThisPending: boolean;
}>) {
  return (
    <div className="grid gap-2 border-t border-white/10 p-2">
      {/* 单列：卡片收窄到 260px 后，两列会让「Looks like them」在固定 h-8 的按钮里折行溢出。 */}
      <div className="grid grid-cols-1 gap-2" aria-label="Character identity feedback">
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-400/15 px-3 text-[11px] font-bold text-emerald-100"
          onClick={onIdentityMatch}
          type="button"
        >
          <Check className="h-3.5 w-3.5" />
          Looks like them
        </button>
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-rose-400/15 px-3 text-[11px] font-bold text-rose-100"
          onClick={onIdentityMismatch}
          type="button"
        >
          <X className="h-3.5 w-3.5" />
          Doesn&apos;t match
        </button>
      </div>
      <div className={`grid gap-2 ${canAddToIdentity ? "grid-cols-2" : "grid-cols-1"}`}>
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-white px-3 text-[11px] font-black text-[rgb(13,13,13)]"
          disabled={moreLikeThisPending}
          onClick={onMoreLikeThis}
          type="button"
        >
          {moreLikeThisPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <WandSparkles className="h-3.5 w-3.5" />
          )}
          {moreLikeThisPending
            ? "Checking price…"
            : "More like this"}
        </button>
        {canAddToIdentity && (
          <button
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-white/10 px-3 text-[11px] font-bold text-white"
            onClick={onAddToIdentity}
            type="button"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Use for identity
          </button>
        )}
      </div>
      <Link
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-black/30 px-3 text-[11px] font-bold text-white"
        href={characterId ? `/generate?characterId=${encodeURIComponent(characterId)}` : "/generate"}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open in Generate
      </Link>
    </div>
  );
}

function isInvalidChatImagePreview(image: HTMLImageElement) {
  if (image.naturalWidth <= 1 || image.naturalHeight <= 1) return true;
  return isBlankChatImagePreview(image);
}

function isBlankChatImagePreview(image: HTMLImageElement) {
  const width = Math.min(16, image.naturalWidth);
  const height = Math.min(16, image.naturalHeight);
  if (width <= 0 || height <= 0) return false;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;

    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let min = 255;
    let max = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index] ?? 0;
      const green = data[index + 1] ?? 0;
      const blue = data[index + 2] ?? 0;
      const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
      min = Math.min(min, luminance);
      max = Math.max(max, luminance);
    }

    const range = max - min;
    return range <= 1 || (range <= 4 && (min >= 250 || max <= 5));
  } catch {
    return false;
  }
}

function parseStreamEvent(event: Event): Record<string, unknown> {
  try {
    const data = (event as MessageEvent<string>).data;
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}
