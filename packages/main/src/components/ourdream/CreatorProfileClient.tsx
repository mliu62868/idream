"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, HeartHandshake } from "lucide-react";
import { useEffect, useState } from "react";
import {
  parseCreatorResponse,
  parseFollowMutationResponse,
  type PublicCreator,
} from "@/lib/public-api-contracts";
import type { CharacterCardData } from "@/types/ourdream";
import { AppSidebar } from "./AppSidebar";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { CharacterCard } from "./CharacterCard";
import { MobileBottomNav } from "./MobileBottomNav";
import { SiteFooter } from "./SiteFooter";
import { authHrefForTarget } from "./authRedirect";

type CreatorProfile = PublicCreator["creator"];

export function CreatorProfileClient({ id }: Readonly<{ id: string }>) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [creator, setCreator] = useState<CreatorProfile>();
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [status, setStatus] = useState("Loading creator...");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [followPending, setFollowPending] = useState(false);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const controller = new AbortController();
    fetch(`/api/v1/creators/${id}`, { signal: controller.signal })
      .then(async (response) => {
        const rawPayload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const serverMessage = apiErrorMessage(rawPayload);
          if (!controller.signal.aborted) {
            setStatus(creatorLoadErrorMessage(response.status, serverMessage));
            setRetryAvailable(response.status >= 500);
          }
          return;
        }
        const payload = parseCreatorResponse(rawPayload);
        if (controller.signal.aborted) return;
        setCreator(payload.creator);
        setCharacters(payload.characters);
        setStatus("");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStatus(creatorLoadErrorMessage(null));
        setRetryAvailable(true);
      });
    return () => controller.abort();
  }, [ageGateAccepted, id, loadAttempt]);

  async function toggleFollow() {
    if (!creator || creator.isSelf || followPending) return;
    const next = !creator.isFollowing;
    setFollowPending(true);
    try {
      const response = await fetch(`/api/v1/users/${creator.id}/follow`, {
        method: next ? "POST" : "DELETE",
      });
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign(
            authHrefForTarget("/signup", `/creators/${encodeURIComponent(id)}`),
          );
          return;
        }
        setStatus("Could not update follow. Please try again.");
        return;
      }
      const authority = parseFollowMutationResponse(await response.json());
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
    } catch {
      setStatus("Could not update follow. Please try again.");
    } finally {
      setFollowPending(false);
    }
  }

  function retryLoad() {
    setCreator(undefined);
    setCharacters([]);
    setStatus("Loading creator...");
    setRetryAvailable(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref="/community" />
        <section className="min-w-0 flex-1 px-4 py-8 pb-24 md:px-[60px] md:py-12">
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
                {!creator.isSelf && (
                  <button
                    aria-pressed={creator.isFollowing}
                    className={`ml-auto inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-[13px] font-black ${
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
              </header>

              {status && (
                <p
                  aria-live="polite"
                  className="mt-4 text-[13px] font-bold text-[rgb(255,138,210)]"
                  data-testid="creator-profile-status"
                  role="status"
                >
                  {status}
                </p>
              )}

              <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
                {characters.map((card, index) => (
                  <CharacterCard
                    card={card}
                    imageLoading={index < 5 ? "eager" : "lazy"}
                    imageUnoptimized={index < 5}
                    key={card.id}
                  />
                ))}
              </div>
              {characters.length === 0 && (
                <p className="mt-8 text-[13px] font-medium text-[rgb(170,170,170)]">
                  This creator has no public characters yet.
                </p>
              )}
            </>
          ) : (
            <p
              aria-live="polite"
              className="mt-8 text-[13px] font-medium text-[rgb(170,170,170)]"
              data-testid="creator-profile-status"
              role="status"
            >
              {status}
              {retryAvailable ? (
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
      <SiteFooter />
      <MobileBottomNav activeHref="/community" />
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
