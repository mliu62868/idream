"use client";

import Link from "next/link";
import { Compass, MessageCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";

// SPEC: /chat landing — a real hub listing the user's chat sessions (most-recent
//       first), each linking into /chat/{id}. Empty → guide to Explore; logged-out
//       → sign-in CTA. The only other sessions list lives inside an open session
//       (ChatSessionListDrawer), so returning users need this entry point.
// NOTE: GET /api/v1/chat/sessions passes through the BFF raw (a JSON array, not
//       {ok,data}); a logged-out request returns 401.
type SessionRow = {
  id: string;
  title: string | null;
  characterId: string;
  status: string;
  memoryEnabled: boolean;
  lastMessageAt: string | null;
  memorySummary: string | null;
};

type HubState = "loading" | "ready" | "error" | "signed-out";

export function ChatHubWorkspace() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [state, setState] = useState<HubState>("loading");

  async function load() {
    setState("loading");
    try {
      const res = await fetch("/api/v1/chat/sessions");
      if (res.status === 401) {
        setState("signed-out");
        return;
      }
      if (!res.ok) throw new Error("sessions unavailable");
      const rows = (await res.json()) as SessionRow[];
      setSessions(
        rows
          .filter((row) => row.status !== "deleted")
          .sort(byMostRecent)
          .slice(0, 50),
      );
      setState("ready");
    } catch {
      setState("error");
    }
  }

  // Defer the first fetch past a macrotask so the initial render commits before any
  // setState (matches ExploreWorkspace/ProfileWorkspace; avoids set-state-in-effect).
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <section className="px-4 py-10 md:px-[60px]">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[38px] font-black uppercase leading-10 text-white">
              Your chats
            </h1>
            <p className="mt-2 text-[14px] font-medium text-[rgb(170,170,170)]">
              Pick up a conversation or start a new one from Explore.
            </p>
          </div>
          <Link
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
            href="/"
          >
            <Compass className="h-4 w-4" />
            Explore
          </Link>
        </div>

        <div className="mt-6 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-6">
          {state === "loading" && (
            <p className="p-10 text-center text-[13px] font-medium text-[rgb(170,170,170)]" role="status">
              Loading your chats…
            </p>
          )}

          {state === "error" && (
            <div className="p-10 text-center">
              <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">Couldn&apos;t load your chats</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Something went wrong. Please try again.
              </p>
              <button
                className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                onClick={() => void load()}
                type="button"
              >
                Retry
              </button>
            </div>
          )}

          {state === "signed-out" && (
            <div className="p-10 text-center">
              <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">Sign in to see your chats</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Log in to pick up your conversations across devices.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Link
                  className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                  href="/login"
                >
                  Log in
                </Link>
                <Link
                  className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
                  href="/signup"
                >
                  Join free
                </Link>
              </div>
            </div>
          )}

          {state === "ready" && sessions.length === 0 && (
            <div className="p-10 text-center">
              <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
              <h2 className="mt-4 text-[22px] font-black uppercase">No chats yet</h2>
              <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                Find a character to start your first conversation.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Link
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                  href="/"
                >
                  <Compass className="h-4 w-4" />
                  Start a chat from Explore
                </Link>
                <Link
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
                  href="/create"
                >
                  <Plus className="h-4 w-4" />
                  Create
                </Link>
              </div>
            </div>
          )}

          {state === "ready" && sessions.length > 0 && (
            <ul className="grid gap-3 md:grid-cols-2">
              {sessions.map((row) => (
                <li key={row.id}>
                  <Link
                    className="flex h-full flex-col rounded-[14px] border border-white/10 bg-[rgb(36,36,36)] p-4 transition-colors hover:bg-[rgb(46,46,46)]"
                    data-testid="chat-hub-session"
                    href={`/chat/${row.id}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-[16px] font-bold text-white">
                        {row.title ?? "Untitled chat"}
                      </span>
                      <span className="shrink-0 text-[12px] font-medium text-[rgb(114,113,112)]">
                        {formatRelative(row.lastMessageAt)}
                      </span>
                    </div>
                    {row.memorySummary ? (
                      <p className="mt-2 line-clamp-1 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                        {row.memorySummary}
                      </p>
                    ) : null}
                    {row.status === "archived" ? (
                      <span className="mt-3 inline-flex w-fit rounded-full bg-black/30 px-2 py-1 text-[11px] font-bold uppercase text-[rgb(114,113,112)]">
                        Archived
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

// Most-recent activity first; sessions without a last message sort to the end.
function byMostRecent(a: SessionRow, b: SessionRow) {
  const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
  const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
  return bt - at;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "New";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
