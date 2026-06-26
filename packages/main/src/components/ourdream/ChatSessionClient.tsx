"use client";

import Link from "next/link";
import { ArrowLeft, Flag, Send } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";

type ChatMessage = {
  id: string;
  role: string;
  content: string;
  status?: string;
};

type ChatSession = {
  id: string;
  title: string | null;
  messages: ChatMessage[];
  character: { name: string };
};

type ChatPayload = {
  data?: {
    session?: ChatSession;
    userMessage?: ChatMessage;
    assistant?: ChatMessage;
    assistantMessageId?: string;
    streamUrl?: string;
  };
};

export function ChatSessionClient({ id }: Readonly<{ id: string }>) {
  const [title, setTitle] = useState("Chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
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
    setContent("");
    setPending(true);
    try {
      const response = await fetch(`/api/v1/chat/sessions/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
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

      if (streamUrl) {
        setMessages((current) => [
          ...current,
          userMessage,
          { ...assistant, content: "" },
        ]);
        streamAssistant(streamUrl, assistant.id, assistant.content);
      } else {
        setMessages((current) => [...current, userMessage, assistant]);
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
          <div className="mt-6 flex min-h-[55vh] flex-1 flex-col gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
            {messages.map((message) => (
              <div
                aria-label={message.role === "user" ? "Your message" : "Assistant message"}
                className={`group relative max-w-[78%] rounded-[16px] px-4 py-3 pr-11 text-[14px] leading-6 ${
                  message.role === "user"
                    ? "ml-auto bg-white text-[rgb(13,13,13)]"
                    : "bg-[rgb(36,36,36)] text-white"
                }`}
                data-message-id={message.id}
                data-testid={`chat-message-${message.role}`}
                key={message.id}
              >
                {message.content}
                <button
                  aria-label="Report message"
                  className={`absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full opacity-70 transition-opacity hover:opacity-100 ${
                    message.role === "user"
                      ? "bg-black/10 text-[rgb(13,13,13)]"
                      : "bg-black/30 text-white"
                  }`}
                  onClick={() => reportMessage(message.id)}
                  title="Report message"
                  type="button"
                >
                  <Flag className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
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
            </p>
          ) : null}
        </section>
      </div>
      <MobileBottomNav activeHref="/chat" />
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
