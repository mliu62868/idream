"use client";

import { ChatMessageText } from "./chat-message-text";
import type { CachedChatMessage } from "./chat-session-storage";

// SPEC: First paint of a conversation. The last messages this tab saw are
//       shown (dimmed, without actions) while Main's read is in flight;
//       a first visit gets bubble-shaped placeholders instead of a spinner.
// INVARIANT: nothing here is interactive — actions need Main's current state.
export function ChatSessionLoading({ cached }: Readonly<{ cached: readonly CachedChatMessage[] }>) {
  return (
    <div
      aria-busy="true"
      className="mt-6 flex min-h-[55vh] flex-1 flex-col justify-end gap-3 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4"
      data-testid="chat-session-loading"
    >
      <p className="sr-only" role="status">Loading the latest messages…</p>
      {cached.length > 0 ? cached.map((message) => {
        const isUser = message.role === "user";
        return (
          <div
            className={`min-w-0 max-w-full rounded-[16px] px-4 py-3 text-[15px] leading-6 opacity-70 md:max-w-[78%] md:text-[14px] ${isUser ? "ml-auto bg-white text-[rgb(13,13,13)]" : "bg-[rgb(36,36,36)] text-white"}`}
            data-cached-message-id={message.id}
            key={message.id}
          >
            {message.speakerName ? <p className="mb-1 text-xs font-bold opacity-75">{isUser ? `You → ${message.speakerName}` : message.speakerName}</p> : null}
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]"><ChatMessageText text={message.content} /></span>
          </div>
        );
      }) : (
        <>
          <div aria-hidden className="h-16 w-[72%] animate-pulse rounded-[16px] bg-white/[0.06] motion-reduce:animate-none" />
          <div aria-hidden className="ml-auto h-10 w-[48%] animate-pulse rounded-[16px] bg-white/[0.09] motion-reduce:animate-none" />
          <div aria-hidden className="h-24 w-[80%] animate-pulse rounded-[16px] bg-white/[0.06] motion-reduce:animate-none" />
        </>
      )}
      <div aria-hidden className="mt-2 h-12 w-full animate-pulse rounded-3xl bg-white/[0.05] motion-reduce:animate-none" />
    </div>
  );
}
