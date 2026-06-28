"use client";

import Link from "next/link";
import { ArrowLeft, Send } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { ChatHeaderControls } from "./chat/ChatHeaderControls";
import { ChatSessionListDrawer } from "./chat/ChatSessionListDrawer";
import { MemoryPanel } from "./chat/MemoryPanel";
import { MessageActions } from "./chat/MessageActions";

type ChatMessage = {
  id: string;
  role: string;
  content: string;
  status?: string;
};

type ChatSession = {
  id: string;
  title: string | null;
  characterId?: string;
  memoryEnabled?: boolean;
  messages: ChatMessage[];
  character: { name: string };
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

export function ChatSessionClient({ id }: Readonly<{ id: string }>) {
  const [title, setTitle] = useState("Chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [quotaReached, setQuotaReached] = useState(false);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryPending, setMemoryPending] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [relationshipRefreshKey, setRelationshipRefreshKey] = useState(0);
  const streamSources = useRef<Map<string, EventSource>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((session) => {
        if (cancelled) return;
        applySession(session);
        resumePendingStreams(session.messages);
      })
      .catch(() => {
        if (!cancelled) setStatus("Chat unavailable. Please try again in a moment.");
      });
    return () => {
      cancelled = true;
    };
    // The loader intentionally reruns only when the route session id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const sources = streamSources.current;
    return () => {
      for (const source of sources.values()) source.close();
      sources.clear();
    };
  }, []);

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
    } finally {
      setPending(false);
    }
  }

  async function reportMessage(messageId: string) {
    setStatus(null);
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
  }

  async function fetchSession(): Promise<ChatSession> {
    const response = await fetch(`/api/v1/chat/sessions/${id}`);
    if (!response.ok) throw new Error("Chat unavailable");
    const payload = (await response.json()) as ChatPayload;
    const session = payload.data?.session;
    if (!session) throw new Error("Chat unavailable");
    return session;
  }

  function applySession(session: ChatSession) {
    setTitle(session.title ?? session.character.name);
    setMessages(session.messages);
    if (session.characterId) setCharacterId(session.characterId);
    if (typeof session.memoryEnabled === "boolean") setMemoryEnabled(session.memoryEnabled);
  }

  // SPEC: Flip long-term memory for this session; optimistic, reconciled from the
  //       updated session row the BFF returns (raw, not {ok,data}).
  async function toggleMemory() {
    if (memoryPending) return;
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
    const response = await fetch(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    });
    if (response.ok) {
      setMessages((current) => current.filter((message) => message.id !== messageId));
    } else {
      setStatus("Couldn't delete the message. Please try again.");
    }
  }

  // SPEC: Regenerate an assistant turn — POST returns a fresh attempt id + streamUrl;
  //       swap the bubble to that id, clear it, and reuse streamAssistant() so the
  //       new reply streams in identically to a normal turn.
  async function regenerate(messageId: string) {
    if (pending) return;
    setStatus(null);
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
      void finishEmpty().finally(close);
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
              return (
                <div
                  aria-label={isUser ? "Your message" : "Assistant message"}
                  className={`group relative max-w-[78%] rounded-[16px] px-4 py-3 text-[14px] leading-6 ${
                    isUser
                      ? "ml-auto bg-white text-[rgb(13,13,13)] pr-[76px]"
                      : "bg-[rgb(36,36,36)] text-white pr-[104px]"
                  }`}
                  data-message-id={message.id}
                  data-testid={`chat-message-${message.role}`}
                  key={message.id}
                >
                  {message.content}
                  <MessageActions
                    isUser={isUser}
                    pending={pending}
                    onReport={() => reportMessage(message.id)}
                    onDelete={() => deleteMessage(message.id)}
                    onRegenerate={isUser ? undefined : () => regenerate(message.id)}
                  />
                </div>
              );
            })}
          </div>
          <form className="mt-4 flex gap-2" onSubmit={submit}>
            <input
              aria-label="Message"
              className="h-12 min-w-0 flex-1 rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-medium outline-none placeholder:text-[rgb(114,113,112)]"
              onChange={(event) => setContent(event.target.value)}
              placeholder="Message..."
              value={content}
            />
            <button
              aria-label="Send message"
              className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-white disabled:opacity-70"
              disabled={pending}
              type="submit"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
          {status ? (
            <p className="mt-3 text-[13px] font-semibold text-[#ff7ac8]" role="status">
              {status}
              {quotaReached ? (
                <>
                  {" "}
                  <Link className="underline hover:text-white" href="/upgrade">
                    Upgrade for unlimited messages
                  </Link>
                  .
                </>
              ) : null}
            </p>
          ) : null}
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

function parseStreamEvent(event: Event): Record<string, unknown> {
  try {
    const data = (event as MessageEvent<string>).data;
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}
