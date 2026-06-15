"use client";

import Link from "next/link";
import { ArrowLeft, Send } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";

type ChatMessage = {
  id: string;
  role: string;
  content: string;
};

type ChatPayload = {
  data?: {
    session?: {
      id: string;
      title: string | null;
      messages: ChatMessage[];
      character: { name: string };
    };
    userMessage?: ChatMessage;
    assistant?: ChatMessage;
  };
};

export function ChatSessionClient({ id }: Readonly<{ id: string }>) {
  const [title, setTitle] = useState("Chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/chat/sessions/${id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Chat unavailable");
        return (await response.json()) as ChatPayload;
      })
      .then((payload) => {
        const session = payload.data?.session;
        if (!session) return;
        setTitle(session.title ?? session.character.name);
        setMessages(session.messages);
      })
      .catch(() => undefined);
  }, [id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = content.trim();
    if (!text || pending) return;
    setContent("");
    setPending(true);
    try {
      const response = await fetch(`/api/v1/chat/sessions/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      const payload = (await response.json()) as ChatPayload;
      const next = [payload.data?.userMessage, payload.data?.assistant].filter(
        Boolean,
      ) as ChatMessage[];
      setMessages((current) => [...current, ...next]);
    } finally {
      setPending(false);
    }
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
                className={`max-w-[78%] rounded-[16px] px-4 py-3 text-[14px] leading-6 ${
                  message.role === "user"
                    ? "ml-auto bg-white text-[rgb(13,13,13)]"
                    : "bg-[rgb(36,36,36)] text-white"
                }`}
                key={message.id}
              >
                {message.content}
              </div>
            ))}
          </div>
          <form className="mt-4 flex gap-2" onSubmit={submit}>
            <input
              className="h-12 min-w-0 flex-1 rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-medium outline-none placeholder:text-[rgb(114,113,112)]"
              onChange={(event) => setContent(event.target.value)}
              placeholder="Message..."
              value={content}
            />
            <button
              className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-white disabled:opacity-70"
              disabled={pending}
              type="submit"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </section>
      </div>
      <MobileBottomNav activeHref="/chat" />
    </main>
  );
}
