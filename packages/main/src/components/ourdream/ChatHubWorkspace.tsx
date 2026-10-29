"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronDown, Compass, MessageCircle, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseCharacterListResponse,
  parseChatSessionsResponse,
  type PublicChatSession as SessionRow,
} from "@/lib/public-api-contracts";
import type { CharacterCardData } from "@/types/ourdream";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { useViewerGate, type ViewerGate } from "@/hooks/useViewerGate";
import { isAbortError } from "@/lib/viewer-resource-client";

// SPEC: /chat landing — a real hub listing the user's chat sessions (most-recent
//       first), each linking into /chat/{id}. Empty → guide to Explore; logged-out
//       → sign-in CTA. The only other sessions list lives inside an open session
//       (ChatSessionListDrawer), so returning users need this entry point.
// NOTE: GET /api/v1/chat/sessions passes through the BFF raw (a JSON array, not
//       {ok,data}); a logged-out request returns 401.
type HubState = "loading" | "ready" | "error" | "signed-out";
type FeaturedState = "loading" | "ready" | "error";

export function ChatHubWorkspace() {
  const viewer = useViewerGate({ require: "any" });
  return <ChatHubContent viewer={viewer} key={viewer.scope ?? (viewer.identity ? "anonymous" : "unconfirmed")} />;
}

function ChatHubContent({ viewer }: Readonly<{ viewer: ViewerGate }>) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [state, setState] = useState<HubState>("loading");
  const [visibleCount, setVisibleCount] = useState(50);
  const [archivedVisibleCount, setArchivedVisibleCount] = useState(50);
  const loadEpoch = useRef(0);
  const gatedFetch = viewer.fetch;
  const displayState = viewer.error ? "error" : state;
  const activeSessions = sessions.filter(row => row.status !== "archived");
  const archivedSessions = sessions.filter(row => row.status === "archived");

  const load = useCallback(async () => {
    if (!ageGateAccepted || !viewer.identity) return;
    const epoch = ++loadEpoch.current;
    setState("loading");
    try {
      if (viewer.identity.kind === "anonymous") {
        setSessions([]);
        setState("signed-out");
        return;
      }
      const res = await gatedFetch("/api/v1/chat/sessions", { cache: "no-store" });
      if (epoch !== loadEpoch.current) return;
      if (res.status === 401) {
        setSessions([]);
        setState("signed-out");
        return;
      }
      if (!res.ok) throw new Error("sessions unavailable");
      const rows = parseChatSessionsResponse(await res.json());
      if (epoch !== loadEpoch.current) return;
      setSessions(
        rows
          .filter((row) => row.status !== "deleted")
          .sort(byMostRecent),
      );
      setVisibleCount(50);
      setArchivedVisibleCount(50);
      setState("ready");
    } catch (error) {
      if (isAbortError(error)) return;
      if (epoch === loadEpoch.current) setState("error");
    }
  }, [ageGateAccepted, gatedFetch, viewer.identity]);

  // Defer the first fetch past a macrotask so the initial render commits before any
  // setState (matches ExploreWorkspace/ProfileWorkspace; avoids set-state-in-effect).
  useEffect(() => {
    if (!ageGateAccepted || !viewer.identity) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); loadEpoch.current += 1; };
  }, [ageGateAccepted, load, viewer.identity, viewer.revalidation]);

  return (
    <section className="px-4 py-10 md:px-[60px]">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[38px] font-black uppercase leading-10 text-white">
              Your chats
            </h1>
            <p className="mt-2 text-[14px] font-medium text-[rgb(170,170,170)]">
              Continue your story, or meet someone new.
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

        <Link className="mt-5 inline-flex min-h-11 items-center rounded-full border border-white/20 px-5 text-sm font-bold hover:bg-white/10" href="/chat/groups">Create or open a group chat</Link>
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            {displayState === "loading" && (
              <p
                aria-live="polite"
                className="p-10 text-center text-[13px] font-medium text-[rgb(170,170,170)]"
                data-testid="chat-hub-status"
                role="status"
              >
                Loading your chats...
              </p>
            )}

            {displayState === "error" && (
              <div
                aria-live="assertive"
                className="p-10 text-center"
                data-testid="chat-hub-status"
                role="alert"
              >
                <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
                <h2 className="mt-4 text-[22px] font-black uppercase">Couldn&apos;t load your chats</h2>
                <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                  Something went wrong. Please try again.
                </p>
                <button
                  className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                  onClick={() => { if (viewer.error) void viewer.revalidate(); else void load(); }}
                  type="button"
                >
                  Retry
                </button>
              </div>
            )}

            {displayState === "signed-out" && (
              <div className="p-10 text-center" data-testid="chat-hub-auth-required">
                <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
                <h2 className="mt-4 text-[22px] font-black uppercase">Sign in to see your chats</h2>
                <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                  Save long-running sessions, keep each character&apos;s memory across sessions, and return to your latest roleplay.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <Link
                    className="inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                    href={authHrefForTarget("/login", "/chat")}
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
            )}

            {displayState === "ready" && sessions.length === 0 && (
              <div className="p-10 text-center">
                <MessageCircle className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
                <h2 className="mt-4 text-[22px] font-black uppercase">No chats yet</h2>
                <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
                  Start from a public character, then return here when you want to continue.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <Link
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
                    href="/"
                  >
                    <Compass className="h-4 w-4" />
                    Explore characters
                  </Link>
                  <Link
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
                    href="/create"
                  >
                    <Plus className="h-4 w-4" />
                    Create private character
                  </Link>
                </div>
              </div>
            )}

            {displayState === "ready" && activeSessions.length > 0 && (
              <ul className="grid gap-3">
                {activeSessions.slice(0, visibleCount).map((row, index) => (
                  <li key={row.id}>
                    <SessionLink row={row} continueLatest={index === 0} />
                  </li>
                ))}
              </ul>
            )}
            {displayState === "ready" && visibleCount < activeSessions.length ? (
              <button className="mt-4 min-h-11 rounded-full bg-white/10 px-4 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white" onClick={() => setVisibleCount(count => count + 50)} type="button">
                Load more chats
              </button>
            ) : null}
            {displayState === "ready" && archivedSessions.length > 0 ? (
              <details className="group mt-6 border-t border-white/10 pt-4">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-bold text-[rgb(190,190,190)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white [&::-webkit-details-marker]:hidden">
                  Archived chats ({archivedSessions.length})
                  <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
                </summary>
                <p className="mb-3 text-sm text-[rgb(170,170,170)]">Your past conversations are still here to read.</p>
                <ul className="grid gap-3">
                  {archivedSessions.slice(0, archivedVisibleCount).map(row => <li key={row.id}><SessionLink row={row} /></li>)}
                </ul>
                {archivedVisibleCount < archivedSessions.length ? (
                  <button className="mt-4 min-h-11 rounded-full bg-white/10 px-4 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white" onClick={() => setArchivedVisibleCount(count => count + 50)} type="button">
                    Load more archived chats
                  </button>
                ) : null}
              </details>
            ) : null}
          </div>

          {displayState !== "loading" ? <ChatStartPanel viewer={viewer} /> : null}
        </div>
      </div>
    </section>
  );
}

function SessionLink({ row, continueLatest = false }: Readonly<{ row: SessionRow; continueLatest?: boolean }>) {
  return (
    <Link
      className={`flex items-start gap-4 rounded-[14px] border p-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${continueLatest ? "border-white/25 bg-[rgb(36,36,36)] hover:bg-[rgb(46,46,46)]" : "border-white/10 bg-[rgb(18,18,18)] hover:bg-[rgb(36,36,36)]"}`}
      data-testid="chat-hub-session"
      href={`/chat/${row.id}`}
    >
      <span className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10">
        {row.characterImage ? (
          <Image alt="" className="object-cover object-top" fill sizes="56px" src={row.characterImage} unoptimized={isProtectedMediaUrl(row.characterImage)} />
        ) : <MessageCircle aria-hidden className="size-6 text-[rgb(170,170,170)]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex min-w-0 items-center gap-2">
            {row.unreadProactiveAt ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-[rgb(253,95,194)]" data-testid="chat-hub-unread-dot" /> : null}
            <span className="break-words text-[16px] font-bold text-white">{row.title ?? "Untitled chat"}</span>
          </span>
          <span className="shrink-0 text-[12px] font-medium text-[rgb(170,170,170)]">
            {row.unreadProactiveAt ? <span className="text-[rgb(253,95,194)]">New message</span> : formatRelative(row.lastMessageAt)}
          </span>
        </span>
        {row.lastMessage ? (
          <span className="mt-2 line-clamp-2 break-words text-sm leading-6 text-[rgb(190,190,190)]">
            {row.lastMessage.role === "user" ? "You: " : ""}{row.lastMessage.content}
          </span>
        ) : null}
        {continueLatest ? (
          <span className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-[rgb(253,95,194)]" data-testid="chat-hub-continue">
            Continue chat <ArrowRight aria-hidden className="size-4" />
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function ChatStartPanel({ viewer }: Readonly<{ viewer: ViewerGate }>) {
  const gatedFetch = viewer.fetch;
  const loadEpoch = useRef(0);
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [featuredCharacters, setFeaturedCharacters] = useState<
    CharacterCardData[]
  >([]);
  const [featuredState, setFeaturedState] = useState<FeaturedState>("loading");

  const loadFeaturedCharacters = useCallback(async () => {
    if (!ageGateAccepted) return;
    const epoch = ++loadEpoch.current;
    setFeaturedState("loading");
    try {
      const response = await gatedFetch("/api/v1/characters?sort=for-you&limit=3");
      if (!response.ok) throw new Error("characters unavailable");
      const payload = parseCharacterListResponse(await response.json());
      if (epoch !== loadEpoch.current) return;
      setFeaturedCharacters(payload.items.slice(0, 3));
      setFeaturedState("ready");
    } catch (error) {
      if (epoch !== loadEpoch.current || isAbortError(error)) return;
      setFeaturedCharacters([]);
      setFeaturedState("error");
    }
  }, [ageGateAccepted, gatedFetch]);

  useEffect(() => {
    if (!ageGateAccepted || !viewer.identity) return;
    const timer = window.setTimeout(() => void loadFeaturedCharacters(), 0);
    return () => { window.clearTimeout(timer); loadEpoch.current += 1; };
  }, [ageGateAccepted, loadFeaturedCharacters, viewer.identity, viewer.revalidation]);

  return (
    <aside
      className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-5"
      data-testid="chat-hub-start-panel"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-[rgb(253,95,194)]" />
        <h2 className="text-[16px] font-black uppercase leading-5 text-white">
          Start a conversation
        </h2>
      </div>
      <p className="mt-2 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
        Jump into a featured character, browse the full catalog, or create a private character.
      </p>

      <div className="mt-4 grid gap-3">
        {featuredState === "loading" ? (
          <p
            aria-live="polite"
            className="rounded-[14px] border border-white/10 bg-[rgb(36,36,36)] p-4 text-[12px] font-medium text-[rgb(170,170,170)]"
            data-testid="chat-hub-featured-status"
            role="status"
          >
            Loading featured characters...
          </p>
        ) : null}
        {featuredState === "ready" && featuredCharacters.length === 0 ? (
          <p
            aria-live="polite"
            className="rounded-[14px] border border-white/10 bg-[rgb(36,36,36)] p-4 text-[12px] font-medium leading-5 text-[rgb(170,170,170)]"
            data-testid="chat-hub-featured-status"
            role="status"
          >
            No public characters are available yet.
          </p>
        ) : null}
        {featuredState === "error" ? (
          <p
            aria-live="assertive"
            className="rounded-[14px] border border-white/10 bg-[rgb(36,36,36)] p-4 text-[12px] font-medium leading-5 text-[rgb(170,170,170)]"
            data-testid="chat-hub-featured-status"
            role="alert"
          >
            Featured characters are temporarily unavailable.
          </p>
        ) : null}
        {featuredState === "ready"
          ? featuredCharacters.map((card) => (
              <Link
                aria-label={`Chat with ${card.title}`}
                className="group grid grid-cols-[64px_minmax(0,1fr)_18px] items-center gap-3 rounded-[14px] border border-white/10 bg-[rgb(36,36,36)] p-2 transition-colors hover:bg-[rgb(46,46,46)]"
                data-testid="chat-hub-character-card"
                href={`/characters/${card.id}`}
                key={card.id}
              >
                <span className="relative block aspect-[4/5] overflow-hidden rounded-[10px] bg-black">
                  <Image
                    alt=""
                    className="object-cover object-top transition-transform duration-200 group-hover:scale-[1.03]"
                    fill
                    sizes="64px"
                    src={card.image}
                    unoptimized={isProtectedMediaUrl(card.image)}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-bold text-white">
                    {card.title}
                  </span>
                  <span className="mt-1 block text-[12px] font-medium text-[rgb(170,170,170)]">
                    {typeof card.chatsCount === "number" && card.chatsCount > 0
                      ? `${card.chats} chats`
                      : card.source === "official"
                        ? "Official character"
                        : "New public character"}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 text-[rgb(114,113,112)] transition-colors group-hover:text-white" />
              </Link>
            ))
          : null}
      </div>

      <div className="mt-4 grid gap-2">
        <Link
          className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-4 text-[13px] font-black text-[rgb(13,13,13)]"
          href="/"
        >
          <Compass className="h-4 w-4" />
          Explore characters
        </Link>
        <Link
          className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-black text-white"
          href="/create"
        >
          <Plus className="h-4 w-4" />
          Create private character
        </Link>
      </div>
    </aside>
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

function isProtectedMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}
