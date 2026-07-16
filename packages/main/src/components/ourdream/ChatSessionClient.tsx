"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  ImageIcon,
  ListChecks,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  WandSparkles,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { ChatHeaderControls } from "./chat/ChatHeaderControls";
import { ChatSessionListDrawer } from "./chat/ChatSessionListDrawer";
import { MemoryPanel } from "./chat/MemoryPanel";
import { MessageActions } from "./chat/MessageActions";
import { authHrefForTarget } from "./authRedirect";
import { LegacyTestAssetBadge } from "./LegacyTestAssetBadge";

type ChatMessage = {
  id: string;
  role: string;
  content: string;
  status?: string;
  attachments?: ChatAttachment[];
};

type ChatAttachment = {
  id: string;
  kind: string;
  status: string;
  mediaAssetId?: string | null;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  isSynthetic?: boolean;
  sourceAuthority?: "legacy_test_asset" | "media_asset";
  costDreamcoins?: number | null;
  promptHint?: string | null;
  width?: number | null;
  height?: number | null;
  errorCode?: string | null;
};

type ChatSession = {
  id: string;
  title: string | null;
  characterId?: string;
  memoryEnabled?: boolean;
  messages: ChatMessage[];
  character: { canUpdateIdentity?: boolean; name: string };
};

type ChatPayload = {
  data?: {
    session?: ChatSession;
    userMessage?: ChatMessage;
    assistant?: ChatMessage;
    assistantMessageId?: string;
    streamUrl?: string | null;
    safety?: { layer: "input" | "output"; policyCode?: string };
  };
};

type ChatLoadState = "loading" | "ready" | "signed-out" | "error";

const BLOCKED_ASSISTANT_NOTICE = "I can’t help with that request.";

function upgradeHrefForChatSession(sessionId: string) {
  return `/upgrade?returnTo=${encodeURIComponent(`/chat/${encodeURIComponent(sessionId)}`)}`;
}

export function ChatSessionClient({ id }: Readonly<{ id: string }>) {
  const [title, setTitle] = useState("Chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadState, setLoadState] = useState<ChatLoadState>("loading");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [quotaReached, setQuotaReached] = useState(false);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [canUpdateIdentity, setCanUpdateIdentity] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryPending, setMemoryPending] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [relationshipRefreshKey, setRelationshipRefreshKey] = useState(0);
  const [voiceLoadingId, setVoiceLoadingId] = useState<string | null>(null);
  const [voicePlayingId, setVoicePlayingId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingPending, setEditingPending] = useState(false);
  const [deleteConfirmMessageId, setDeleteConfirmMessageId] = useState<string | null>(null);
  const streamSources = useRef<Map<string, EventSource>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const canSend = content.trim().length > 0 && !pending;

  // SPEC: Keep the newest message (and its streaming deltas) in view; without this
  //       the reply renders below the fold and the input is pushed off-screen.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoadState("loading");
      setStatus(null);
      fetchSession()
        .then((session) => {
          if (cancelled) return;
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
      window.clearTimeout(timer);
    };
    // The loader intentionally reruns only when the route session id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const sources = streamSources.current;
    return () => {
      for (const source of sources.values()) source.close();
      sources.clear();
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const hasActiveAttachment = messages.some((message) =>
      (message.attachments ?? []).some((attachment) =>
        ["requesting", "queued", "running"].includes(attachment.status),
      ),
    );
    if (!hasActiveAttachment) return;
    const timer = window.setInterval(() => {
      fetchSession().then(applySession).catch(() => {});
    }, 2_000);
    return () => window.clearInterval(timer);
    // Attachment polling is intentionally driven by message attachment state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    const hasEmptyGeneratingReply = messages.some(
      (message) =>
        message.role === "assistant" &&
        !message.content.trim() &&
        (message.status === "generating" || message.status === "pending"),
    );
    if (!hasEmptyGeneratingReply) return;

    const timer = window.setInterval(() => {
      fetchSession()
        .then((session) => {
          applySession(session);
          const failedEmptyReply = session.messages.some(
            (message) =>
              message.role === "assistant" &&
              !message.content.trim() &&
              message.status &&
              !["generating", "pending"].includes(message.status),
          );
          if (failedEmptyReply) setStatus("Reply failed to load. Please try again.");
        })
        .catch(() => {});
    }, 1_500);
    return () => window.clearInterval(timer);
    // Empty assistant polling is a fallback for missed SSE events; streamed
    // deltas stop the poll because the assistant content is no longer empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  function stopVoice() {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    audioRef.current = null;
    setVoicePlayingId(null);
  }

  // SPEC: On-demand TTS playback for an assistant turn. POSTs the message to the
  //       voice endpoint (server caches per messageId), then streams the audio.
  // INTENT: clicking again toggles playback off; 402 surfaces the upgrade path.
  async function playMessage(messageId: string, text: string) {
    if (!characterId || !text.trim()) return;
    if (voicePlayingId === messageId) {
      stopVoice();
      return;
    }
    stopVoice();
    setStatus(null);
    setVoiceLoadingId(messageId);
    try {
      const response = await fetch("/api/v1/generation/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId, messageId, sessionId: id, text }),
      });
      if (response.status === 402) {
        setQuotaReached(true);
        setStatus("Voice playback needs a plan with voice enabled.");
        return;
      }
      if (!response.ok) {
        setStatus("Voice playback failed. Please try again.");
        return;
      }
      const payload = (await response.json()) as { data?: { contentUrl?: string } };
      const url = payload.data?.contentUrl;
      if (!url) {
        setStatus("Voice playback failed. Please try again.");
        return;
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () =>
        setVoicePlayingId((current) => (current === messageId ? null : current));
      audio.onerror = () => {
        setStatus("Voice playback failed. Please try again.");
        setVoicePlayingId((current) => (current === messageId ? null : current));
      };
      await audio.play();
      setVoicePlayingId(messageId);
    } catch {
      setStatus("Voice playback failed. Please try again.");
    } finally {
      setVoiceLoadingId((current) => (current === messageId ? null : current));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!text || pending) return;
    setStatus(null);
    setQuotaReached(false);
    setContent("");
    setPending(true);
    try {
      const response = await fetch(`/api/v1/chat/sessions/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      // Quota exhausted: keep the user's input and surface the upgrade path (P0-C).
      if (response.status === 402) {
        setQuotaReached(true);
        setStatus("Daily free message limit reached.");
        setContent(text);
        return;
      }
      if (!response.ok) {
        setStatus("Message failed to send. Please try again.");
        setContent(text);
        return;
      }
      const payload = (await response.json()) as ChatPayload;
      const userMessage = payload.data?.userMessage;
      const assistant = payload.data?.assistant;
      const streamUrl = payload.data?.streamUrl;
      if (!userMessage || !assistant) {
        setStatus("Message failed to send. Please try again.");
        setContent(text);
        return;
      }

      // Blocked input (P0-B): the assistant turn is a terminal safety notice with no
      // stream. Render it in place; do NOT open an EventSource that would never fill.
      if (assistant.status === "blocked" || !streamUrl) {
        setMessages((current) => [...current, userMessage, assistant]);
        if (assistant.status === "blocked") {
          setStatus("That message was blocked by our safety policy.");
        }
      } else {
        setMessages((current) => [
          ...current,
          userMessage,
          { ...assistant, content: "" },
        ]);
        streamAssistant(streamUrl, assistant.id, assistant.content);
      }
    } catch {
      // Network/parse failure: surface the error and restore the typed text so the
      // user's message is never silently lost (P0 — silent message loss).
      setStatus("Message failed to send. Please try again.");
      setContent(text);
    } finally {
      setPending(false);
    }
  }

  async function reportMessage(messageId: string) {
    setStatus(null);
    setDeleteConfirmMessageId(null);
    try {
      const response = await fetch("/api/v1/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetType: "chat_message",
          targetId: messageId,
          category: "other_prohibited_content",
          description: "Chat message report",
        }),
      });
      setStatus(response.ok ? "Report submitted." : "Report failed.");
    } catch {
      setStatus("Report failed.");
    }
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
    setQuotaReached(false);
    setEditingPending(true);
    try {
      const response = await fetch(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: next }),
      });
      if (response.status === 402) {
        setQuotaReached(true);
        setStatus("Daily free message limit reached.");
        return;
      }
      if (!response.ok) {
        setStatus("Couldn't edit the message. Please try again.");
        return;
      }
      const payload = (await response.json()) as {
        assistantMessageId?: string;
        streamUrl?: string | null;
        status?: "generating" | "blocked";
      };
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
      streamAssistant(payload.streamUrl, payload.assistantMessageId, "");
    } catch {
      setStatus("Couldn't edit the message. Please try again.");
    } finally {
      setEditingPending(false);
    }
  }

  async function fetchSession(): Promise<ChatSession> {
    const response = await fetch(`/api/v1/chat/sessions/${id}`);
    if (response.status === 401) throw chatSessionFetchError(401);
    if (!response.ok) throw new Error("Chat unavailable");
    const payload = (await response.json()) as ChatPayload;
    const session = payload.data?.session;
    if (!session) throw new Error("Chat unavailable");
    return session;
  }

  function applySession(session: ChatSession) {
    setTitle(session.title ?? session.character.name);
    setMessages(session.messages);
    setDeleteConfirmMessageId(null);
    if (session.characterId) setCharacterId(session.characterId);
    setCanUpdateIdentity(Boolean(session.character.canUpdateIdentity));
    if (typeof session.memoryEnabled === "boolean") setMemoryEnabled(session.memoryEnabled);
  }

  // SPEC: Flip long-term memory for this session; optimistic, reconciled from the
  //       updated session row the BFF returns (raw, not {ok,data}).
  async function toggleMemory() {
    if (memoryPending) return;
    setDeleteConfirmMessageId(null);
    const next = !memoryEnabled;
    setMemoryPending(true);
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
    } finally {
      setMemoryPending(false);
    }
  }

  async function deleteMessage(messageId: string) {
    setStatus(null);
    if (deleteConfirmMessageId !== messageId) {
      setDeleteConfirmMessageId(messageId);
      setStatus("Press Confirm delete to remove this message.");
      return;
    }
    try {
      const response = await fetch(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
      });
      if (response.ok) {
        setMessages((current) => current.filter((message) => message.id !== messageId));
        setDeleteConfirmMessageId(null);
      } else {
        setStatus("Couldn't delete the message. Please try again.");
        setDeleteConfirmMessageId(null);
      }
    } catch {
      setStatus("Couldn't delete the message. Please try again.");
      setDeleteConfirmMessageId(null);
    }
  }

  async function confirmImageAttachment(attachmentId: string) {
    setStatus(null);
    setDeleteConfirmMessageId(null);
    setMessages((current) => updateAttachmentStatus(current, attachmentId, "requesting"));
    try {
      const response = await fetch(
        `/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/confirm`,
        { method: "POST" },
      );
      if (!response.ok) {
        setMessages((current) => updateAttachmentStatus(current, attachmentId, "proposed"));
        setStatus(response.status === 402 ? "Not enough dreamcoins for this image." : "Image request failed.");
        return;
      }
      fetchSession().then(applySession).catch(() => {});
    } catch {
      setMessages((current) => updateAttachmentStatus(current, attachmentId, "proposed"));
      setStatus("Image request failed.");
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
    setStatus(null);
    setDeleteConfirmMessageId(null);
    try {
      const response = await fetch(`/api/v1/media/${encodeURIComponent(mediaAssetId)}/variation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outputCount: 1, consistencyMode: "balanced" }),
      });
      if (!response.ok) {
        setStatus("Couldn't queue variation.");
        return;
      }
      setStatus("Variation queued. It will appear in Generate and Gallery.");
    } catch {
      setStatus("Couldn't queue variation.");
    }
  }

  // SPEC: Regenerate an assistant turn — POST returns a fresh attempt id + streamUrl;
  //       swap the bubble to that id, clear it, and reuse streamAssistant() so the
  //       new reply streams in identically to a normal turn.
  async function regenerate(messageId: string) {
    if (pending) return;
    setStatus(null);
    setDeleteConfirmMessageId(null);
    try {
      const response = await fetch(
        `/api/v1/messages/${encodeURIComponent(messageId)}/regenerate`,
        { method: "POST" },
      );
      if (!response.ok) {
        setStatus("Couldn't regenerate. Please try again.");
        return;
      }
      const payload = (await response.json()) as {
        assistantMessageId?: string;
        streamUrl?: string | null;
      };
      const newId = payload.assistantMessageId;
      const streamUrl = payload.streamUrl;
      if (!newId || !streamUrl) {
        setStatus("Couldn't regenerate. Please try again.");
        return;
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, id: newId, content: "", status: "generating" }
            : message,
        ),
      );
      streamAssistant(streamUrl, newId, "");
    } catch {
      setStatus("Couldn't regenerate. Please try again.");
    }
  }

  function resumePendingStreams(loadedMessages: ChatMessage[]) {
    for (const message of loadedMessages) {
      if (
        message.role === "assistant" &&
        !message.content.trim() &&
        (message.status === "generating" || message.status === "pending")
      ) {
        streamAssistant(`/api/v1/chat/messages/${encodeURIComponent(message.id)}/stream`, message.id, "");
      }
    }
  }

  function streamAssistant(streamUrl: string, assistantId: string, fallback: string) {
    if (streamSources.current.has(assistantId)) return;

    let streamed = "";
    let finished = false;
    const source = new EventSource(streamUrl);
    streamSources.current.set(assistantId, source);

    const close = () => {
      source.close();
      streamSources.current.delete(assistantId);
    };

    const finishEmpty = async () => {
      if (finished) return;
      finished = true;
      if (streamed) return;
      if (fallback) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, content: fallback } : message,
          ),
        );
        return;
      }
      if (await recoverAssistantFromSession(assistantId)) return;
      setMessages((current) => current.filter((message) => message.id !== assistantId));
      setStatus("Reply failed to load. Please try again.");
    };

    source.addEventListener("delta", (event) => {
      const data = parseStreamEvent(event);
      const delta = typeof data.delta === "string" ? data.delta : "";
      streamed += delta;
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, content: streamed } : message,
        ),
      );
    });

    source.addEventListener("done", () => {
      void finishEmpty()
        .then(() => fetchSession().then(applySession).catch(() => {}))
        .finally(close);
    });

    source.addEventListener("error", () => {
      void finishEmpty().finally(close);
    });
  }

  async function recoverAssistantFromSession(assistantId: string) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 500));
      try {
        const session = await fetchSession();
        applySession(session);
        const assistant = session.messages.find((message) => message.id === assistantId);
        if (assistant?.content.trim()) return true;
        if (assistant && assistant.status && !["generating", "pending"].includes(assistant.status)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return false;
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
                relationshipRefreshKey={relationshipRefreshKey}
                onToggleMemory={toggleMemory}
                onOpenSessions={() => setSessionsOpen(true)}
                onOpenMemory={() => setMemoryOpen(true)}
              />
              <div className="mt-6 flex min-h-[55vh] flex-1 flex-col gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
                {messages.map((message) => {
                  const isUser = message.role === "user";
                  const isEditing = editingMessageId === message.id;
                  const messageDeleteConfirm = deleteConfirmMessageId === message.id;
                  return (
                    <div
                      aria-label={isUser ? "Your message" : "Assistant message"}
                      className={`group relative max-w-[78%] rounded-[16px] px-4 py-3 text-[14px] leading-6 ${
                        isUser
                          ? `ml-auto bg-white text-[rgb(13,13,13)] ${messageDeleteConfirm ? "pr-[128px]" : "pr-[76px]"}`
                          : `bg-[rgb(36,36,36)] text-white ${messageDeleteConfirm ? "pr-[156px]" : "pr-[104px]"}`
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
                      ) : !isUser && !message.content.trim() ? (
                        <span
                          aria-label="Assistant is typing"
                          className="inline-flex items-center gap-1 py-0.5"
                          role="status"
                        >
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60 [animation-delay:-0.3s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60 [animation-delay:-0.15s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60" />
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
                              onAddToIdentity={
                                attachment.mediaAssetId
                                  ? () => addAttachmentToIdentity(attachment.mediaAssetId as string)
                                  : undefined
                              }
                              onConfirm={() => confirmImageAttachment(attachment.id)}
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
                            />
                          ))}
                        </div>
                      ) : null}
                      {!isEditing ? (
                        <MessageActions
                          isUser={isUser}
                          pending={pending || editingPending}
                          voiceState={
                            voiceLoadingId === message.id
                              ? "loading"
                              : voicePlayingId === message.id
                                ? "playing"
                                : undefined
                          }
                          onEdit={
                            isUser && message.id === latestUserMessageId && !latestReplyInProgress
                              ? () => beginEdit(message)
                              : undefined
                          }
                          onReport={() => reportMessage(message.id)}
                          onDelete={() => deleteMessage(message.id)}
                          deleteConfirm={messageDeleteConfirm}
                          onRegenerate={isUser ? undefined : () => regenerate(message.id)}
                          onPlay={
                            isUser || !message.content.trim()
                              ? undefined
                              : () => playMessage(message.id, message.content)
                          }
                        />
                      ) : null}
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
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
                <button
                  aria-label="Send message"
                  className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-white disabled:opacity-70"
                  disabled={!canSend}
                  type="submit"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
              {status ? (
                <p
                  aria-live="polite"
                  className="mt-3 text-[13px] font-semibold text-[#ff7ac8]"
                  data-testid="chat-session-status"
                  role="status"
                >
                  {status}
                  {quotaReached ? (
                    <>
                      {" "}
                      <Link className="underline hover:text-white" href={upgradeHrefForChatSession(id)}>
                        Upgrade for unlimited messages
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
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        characterId={characterId}
        memoryEnabled={memoryEnabled}
        memoryPending={memoryPending}
        onToggleMemory={toggleMemory}
        onRelationshipReset={() => setRelationshipRefreshKey((key) => key + 1)}
      />
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

function updateAttachmentStatus(
  messages: ChatMessage[],
  attachmentId: string,
  status: string,
): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) =>
      attachment.id === attachmentId ? { ...attachment, status } : attachment,
    ),
  }));
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
  onConfirm,
  onAddToIdentity,
  onIdentityMatch,
  onIdentityMismatch,
  onMoreLikeThis,
}: Readonly<{
  attachment: ChatAttachment;
  canAddToIdentity: boolean;
  characterId: string | null;
  onConfirm: () => void;
  onAddToIdentity?: () => void;
  onIdentityMatch?: () => void;
  onIdentityMismatch?: () => void;
  onMoreLikeThis?: () => void;
}>) {
  const source = attachment.thumbnailUrl ?? attachment.mediaUrl;
  const previewKey = `${attachment.id}:${source ?? ""}`;
  const [invalidPreviewKey, setInvalidPreviewKey] = useState<string | null>(null);
  const invalidPreview = invalidPreviewKey === previewKey;
  const isLegacyTestAsset =
    attachment.isSynthetic === true ||
    attachment.sourceAuthority === "legacy_test_asset";

  if (attachment.status === "completed" && attachment.mediaUrl && source && !invalidPreview) {
    return (
      <figure className="relative overflow-hidden rounded-[12px] border border-white/10 bg-black/20">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt={attachment.promptHint ? `Generated image: ${attachment.promptHint}` : "Generated chat image"}
          className="aspect-[4/5] w-full max-w-[260px] object-cover"
          data-testid="chat-image-attachment"
          height={attachment.height ?? 640}
          onError={() => setInvalidPreviewKey(previewKey)}
          onLoad={(event) => {
            if (isInvalidChatImagePreview(event.currentTarget)) setInvalidPreviewKey(previewKey);
          }}
          src={source}
          width={attachment.width ?? 512}
        />
        <LegacyTestAssetBadge
          className="absolute right-2 top-2 z-20"
          isSynthetic={isLegacyTestAsset}
        />
        {attachment.mediaAssetId ? (
          <ChatImageAttachmentActions
            canAddToIdentity={canAddToIdentity}
            characterId={characterId}
            onAddToIdentity={onAddToIdentity}
            onIdentityMatch={onIdentityMatch}
            onIdentityMismatch={onIdentityMismatch}
            onMoreLikeThis={onMoreLikeThis}
          />
        ) : null}
      </figure>
    );
  }

  const isWaiting = ["requesting", "queued", "running"].includes(attachment.status);
  const failed = ["failed", "blocked", "refunded", "rejected"].includes(attachment.status);
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
            {attachment.status === "proposed"
              ? "Image request"
              : failed || completedUnavailable
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
                {attachment.promptHint || "The generated image cannot be previewed."}
              </span>
            </div>
          ) : (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-white/60">
              {failed
                ? "The image could not be completed."
                : attachment.promptHint || "Create an image from this chat moment."}
            </p>
          )}
        </div>
      </div>
      {attachment.status === "proposed" || failed ? (
        <button
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-[12px] font-bold text-[rgb(13,13,13)] disabled:opacity-70"
          onClick={onConfirm}
          type="button"
        >
          {failed ? <RefreshCw className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
          {failed ? "Retry image" : `Generate image${attachment.costDreamcoins ? ` · ${attachment.costDreamcoins} coins` : ""}`}
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
}: Readonly<{
  canAddToIdentity: boolean;
  characterId: string | null;
  onAddToIdentity?: () => void;
  onIdentityMatch?: () => void;
  onIdentityMismatch?: () => void;
  onMoreLikeThis?: () => void;
}>) {
  return (
    <div className="grid gap-2 border-t border-white/10 p-2">
      <div className="grid grid-cols-2 gap-2" aria-label="Character identity feedback">
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-emerald-400/15 px-3 text-[11px] font-bold text-emerald-100"
          onClick={onIdentityMatch}
          type="button"
        >
          <Check className="h-3.5 w-3.5" />
          Looks like them
        </button>
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-rose-400/15 px-3 text-[11px] font-bold text-rose-100"
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
          onClick={onMoreLikeThis}
          type="button"
        >
          <WandSparkles className="h-3.5 w-3.5" />
          More like this
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
