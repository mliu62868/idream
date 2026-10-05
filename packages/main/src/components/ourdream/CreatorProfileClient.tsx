"use client";

import { apiEnvelopeErrorMessage, isAbortError } from "@/lib/viewer-resource-client";
import { useViewerGate, ViewerGateError, type ViewerGate } from "@/hooks/useViewerGate";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Flag, HeartHandshake, Share2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  parseCreatorResponse,
  parseFollowMutationResponse,
  type PublicCreator,
} from "@/lib/public-api-contracts";
import { shareOrCopy } from "@/lib/utils";
import type { CharacterCardData } from "@/types/ourdream";
import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { CharacterCard } from "./CharacterCard";
import { ComicDiscovery } from "./ComicCatalog";
import { MobileBottomNav } from "./MobileBottomNav";
import { useReportDialog } from "./ReportDialog";
import { SiteFooter } from "./SiteFooter";
import { authHrefForTarget } from "./authRedirect";

type CreatorProfile = PublicCreator["creator"];

export function CreatorProfileClient({ id }: Readonly<{ id: string }>) {
  const viewer = useViewerGate({ require: "any" });
  // Cards, self/follow controls and pending commands belong to both the creator
  // and the confirmed viewer. Neither may inherit the previous pair's state.
  return <CreatorProfileContent id={id} viewer={viewer} key={`${id}:${viewer.scope ?? (viewer.identity ? "anonymous" : "unconfirmed")}`} />;
}

function CreatorProfileContent({ id, viewer }: Readonly<{ id: string; viewer: ViewerGate }>) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const gatedFetch = viewer.fetch;
  const mountedRef = useRef(true);
  useLayoutEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const [creator, setCreator] = useState<CreatorProfile>();
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [loadStatus, setLoadStatus] = useState("Loading creator...");
  const [status, setStatus] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [followPending, setFollowPending] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [morePending, setMorePending] = useState(false);
  const moreRequest = useRef<AbortController | null>(null);
  const { openReport, reportDialog } = useReportDialog(setStatus);
  const visibleStatus = [loadStatus, status].filter(Boolean).join(" ");

  useEffect(() => {
    if (!ageGateAccepted || !viewer.identity) return;
    const controller = new AbortController();
    gatedFetch(`/api/v1/creators/${encodeURIComponent(id)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const rawPayload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const serverMessage = apiErrorMessage(rawPayload);
          if (!controller.signal.aborted) {
            setLoadStatus(creatorLoadErrorMessage(response.status, serverMessage));
            setRetryAvailable(response.status >= 500);
          }
          return;
        }
        const payload = parseCreatorResponse(rawPayload);
        if (controller.signal.aborted) return;
        setCreator(payload.creator);
        setCharacters(payload.characters);
        setNextCursor(payload.nextCursor);
        setLoadStatus("");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadStatus(creatorLoadErrorMessage(null));
        setRetryAvailable(true);
      });
    return () => {
      controller.abort();
      moreRequest.current?.abort();
    };
  }, [ageGateAccepted, gatedFetch, id, loadAttempt, viewer.identity, viewer.revalidation]);

  async function loadMore() {
    if (!nextCursor || moreRequest.current) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    setMorePending(true);
    setLoadStatus("");
    try {
      const query = new URLSearchParams({ cursor: nextCursor });
      const response = await gatedFetch(`/api/v1/creators/${encodeURIComponent(id)}?${query}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        if ([400, 409, 410].includes(response.status)) {
          if (!controller.signal.aborted) {
            setLoadStatus("This creator view has changed. Refresh the profile to continue.");
            setRetryAvailable(true);
          }
          return;
        }
        throw new Error("Creator page unavailable");
      }
      const payload = parseCreatorResponse(await response.json());
      if (controller.signal.aborted) return;
      setCharacters((current) => {
        const seen = new Set(current.map((card) => card.id));
        return [...current, ...payload.characters.filter((card) => !seen.has(card.id))];
      });
      setNextCursor(payload.nextCursor);
    } catch (error) {
      if (isAbortError(error)) return;
      if (!controller.signal.aborted) setLoadStatus("Could not load more characters. Please try again.");
    } finally {
      if (!controller.signal.aborted) {
        moreRequest.current = null;
        setMorePending(false);
      }
    }
  }

  async function toggleFollow() {
    if (!creator || creator.isSelf || followPending) return;
    if (viewer.identity?.kind === "anonymous") {
      window.location.assign(authHrefForTarget("/signup", `/creators/${encodeURIComponent(id)}`));
      return;
    }
    const next = !creator.isFollowing;
    setFollowPending(true);
    try {
      const expected = viewer.identity;
      const before = await viewer.revalidate();
      if (!mountedRef.current) throw new ViewerGateError();
      if (!before) throw new Error("Account confirmation unavailable");
      if (before !== expected) throw new ViewerGateError();
      const response = await gatedFetch(`/api/v1/users/${creator.id}/follow`, {
        method: next ? "POST" : "DELETE",
      });
      const after = await viewer.revalidate();
      if (!mountedRef.current) throw new ViewerGateError();
      if (!after) throw new Error("Account confirmation unavailable");
      if (after !== expected) throw new ViewerGateError();
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign(
            authHrefForTarget("/signup", `/creators/${encodeURIComponent(id)}`),
          );
          return;
        }
        setStatus(apiEnvelopeErrorMessage(await response.json().catch(() => null)) ?? "Could not update follow. Please try again.");
        return;
      }
      const authority = parseFollowMutationResponse(await response.json());
      if (!mountedRef.current) return;
      setCreator((current) =>
        current
          ? {
              ...current,
              isFollowing: authority.following,
              stats: {
                ...current.stats,
                followers: authority.followers,
              },
            }
          : current,
      );
    } catch (error) {
      if (!mountedRef.current || isAbortError(error)) return;
      setStatus("Could not update follow. Please try again.");
    } finally {
      if (mountedRef.current) setFollowPending(false);
    }
  }

  function retryLoad() {
    if (viewer.error) { void viewer.revalidate(); return; }
    moreRequest.current?.abort();
    moreRequest.current = null;
    setMorePending(false);
    setCreator(undefined);
    setCharacters([]);
    setNextCursor(null);
    setLoadStatus("Loading creator...");
    setStatus("");
    setRetryAvailable(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref="/community" />
        <div className="min-w-0 flex-1">
          <AppTopbar activeHref="/community" currentPath={`/creators/${id}`} />
          <section className="px-4 py-8 pb-24 md:px-[60px] md:py-12">
          <Link
            className="inline-flex items-center gap-2 text-[13px] font-bold text-[rgb(170,170,170)] hover:text-white"
            href="/community"
          >
            <ArrowLeft className="h-4 w-4" />
            Community
          </Link>

          {creator ? (
            <>
              <header className="mt-6 flex flex-wrap items-center gap-4">
                {creator.image ? (
                  <Image
                    alt=""
                    className="h-20 w-20 rounded-full object-cover"
                    height={80}
                    src={creator.image}
                    unoptimized={isPrivateMediaUrl(creator.image)}
                    width={80}
                  />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[rgb(36,36,36)] text-[28px] font-black uppercase text-white">
                    {creator.displayName.slice(0, 1)}
                  </div>
                )}
                <div className="min-w-0">
                  <h1 className="text-[32px] font-black uppercase leading-none md:text-[44px]">
                    {creator.displayName}
                  </h1>
                  <p className="mt-2 text-[13px] font-medium text-[rgb(170,170,170)]">
                    {creator.stats.characters} characters · {creator.stats.followers} followers
                    {(creator.stats.likesCount ?? 0) > 0
                      ? ` · ${creator.stats.likes} likes`
                      : ""}
                    {(creator.stats.chatsCount ?? 0) > 0
                      ? ` · ${creator.stats.chats} chats`
                      : ""}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  <button
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                    onClick={async () => setStatus(await shareOrCopy(`${window.location.origin}/creators/${encodeURIComponent(id)}`, creator.displayName))}
                    type="button"
                  >
                    <Share2 className="h-4 w-4" />
                    Share
                  </button>
                  {creator.isSelf && (
                    <>
                      <Link className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white" href="/profile">
                        Edit profile
                      </Link>
                      <Link className="inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]" href="/create">
                        Create a character
                      </Link>
                    </>
                  )}
                  {!creator.isSelf && (
                    <button
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                      onClick={() => openReport({ kind: "record", targetType: "user_profile", targetId: creator.id })}
                      type="button"
                    >
                      <Flag className="h-4 w-4" />
                      Report
                    </button>
                  )}
                  {!creator.isSelf && (
                    <button
                      aria-pressed={creator.isFollowing}
                      className={`inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-[13px] font-black ${
                        creator.isFollowing
                          ? "bg-[rgb(36,36,36)] text-white"
                          : "bg-white text-[rgb(13,13,13)]"
                      }`}
                      data-testid="creator-follow"
                      disabled={followPending}
                      onClick={() => void toggleFollow()}
                      type="button"
                    >
                      <HeartHandshake className="h-4 w-4" />
                      {creator.isFollowing ? "Following" : "Follow"}
                    </button>
                  )}
                </div>
              </header>

              {visibleStatus && (
                <p
                  aria-live="polite"
                  className="mt-4 text-[13px] font-bold text-[rgb(255,138,210)]"
                  data-testid="creator-profile-status"
                  role="status"
                >
                  {visibleStatus}
                  {retryAvailable && <button className="ml-3 rounded-full border border-white/20 px-3 py-1 text-white" onClick={retryLoad} type="button">Refresh creator profile</button>}
                </p>
              )}

              <p className="mt-8 text-[13px] font-medium text-[rgb(170,170,170)]">Public characters · newest first</p>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
                {characters.map((card, index) => (
                  <CharacterCard
                    card={card}
                    imageLoading={index < 5 ? "eager" : "lazy"}
                    imageUnoptimized={index < 5}
                    key={card.id}
                  />
                ))}
              </div>
              {nextCursor && (
                <button
                  className="mt-6 rounded-full border border-white/20 px-5 py-3 text-[13px] font-bold disabled:opacity-50"
                  disabled={morePending || retryAvailable}
                  onClick={() => void loadMore()}
                  type="button"
                >
                  {morePending ? "Loading characters..." : "Load more characters"}
                </button>
              )}
              {characters.length === 0 && (
                <p className="mt-8 text-[13px] font-medium text-[rgb(170,170,170)]">
                  {creator?.isSelf
                    ? "You have no public characters yet. Publish one from My AI to show it here."
                    : "This creator has no public characters yet."}
                </p>
              )}
              <ComicDiscovery creatorId={id} />
            </>
          ) : (
            <p
              aria-live="polite"
              className="mt-8 text-[13px] font-medium text-[rgb(170,170,170)]"
              data-testid="creator-profile-status"
              role="status"
            >
              {viewer.error || visibleStatus}
              {retryAvailable || viewer.error ? (
                <button
                  className="ml-3 rounded-full border border-white/20 px-3 py-1 text-white"
                  onClick={retryLoad}
                  type="button"
                >
                  Retry
                </button>
              ) : null}
            </p>
          )}
        </section>
        </div>
      </div>
      <SiteFooter />
      <MobileBottomNav activeHref="/community" />
      {reportDialog}
    </main>
  );
}

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}

function apiErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

export function creatorLoadErrorMessage(
  status: number | null,
  serverMessage?: string,
): string {
  if (status === 401) return "Sign in to view this creator.";
  if (status === 403) return "Accept the age gate to view this creator.";
  if (status === 404) return "Creator not found or not public.";
  if (status !== null && status < 500 && serverMessage) return serverMessage;
  return "Creator is temporarily unavailable. Please try again.";
}
