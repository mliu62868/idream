"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, HeartHandshake } from "lucide-react";
import { useEffect, useState } from "react";
import type { CharacterCardData } from "@/types/ourdream";
import { AppSidebar } from "./AppSidebar";
import { CharacterCard } from "./CharacterCard";
import { MobileBottomNav } from "./MobileBottomNav";
import { SiteFooter } from "./SiteFooter";

type CreatorProfile = {
  id: string;
  displayName: string;
  image: string | null;
  isFollowing: boolean;
  isSelf: boolean;
  stats: { characters: number; followers: number; likes: string; chats: string };
};

type CreatorResponse = {
  ok: boolean;
  data?: { creator: CreatorProfile; characters: CharacterCardData[] };
  error?: { message?: string };
};

export function CreatorProfileClient({ id }: Readonly<{ id: string }>) {
  const [creator, setCreator] = useState<CreatorProfile>();
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [status, setStatus] = useState("Loading creator...");

  useEffect(() => {
    fetch(`/api/v1/creators/${id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Creator unavailable");
        return (await response.json()) as CreatorResponse;
      })
      .then((payload) => {
        if (payload.data?.creator) {
          setCreator(payload.data.creator);
          setCharacters(payload.data.characters ?? []);
          setStatus("");
        }
      })
      .catch(() => setStatus("Accept the age gate or sign in to view this creator."));
  }, [id]);

  async function toggleFollow() {
    if (!creator || creator.isSelf) return;
    const next = !creator.isFollowing;
    setCreator((current) =>
      current
        ? {
            ...current,
            isFollowing: next,
            stats: {
              ...current.stats,
              followers: Math.max(0, current.stats.followers + (next ? 1 : -1)),
            },
          }
        : current,
    );
    const response = await fetch(`/api/v1/users/${creator.id}/follow`, {
      method: next ? "POST" : "DELETE",
    });
    if (!response.ok) {
      setCreator((current) =>
        current
          ? {
              ...current,
              isFollowing: !next,
              stats: {
                ...current.stats,
                followers: Math.max(0, current.stats.followers + (next ? -1 : 1)),
              },
            }
          : current,
      );
      setStatus("Sign in to follow creators.");
    }
  }

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref="/" />
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
                    {creator.stats.characters} characters · {creator.stats.followers} followers ·{" "}
                    {creator.stats.likes} likes · {creator.stats.chats} chats
                  </p>
                </div>
                {!creator.isSelf && (
                  <button
                    className={`ml-auto inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-[13px] font-black ${
                      creator.isFollowing
                        ? "bg-[rgb(36,36,36)] text-white"
                        : "bg-white text-[rgb(13,13,13)]"
                    }`}
                    data-testid="creator-follow"
                    onClick={() => void toggleFollow()}
                    type="button"
                  >
                    <HeartHandshake className="h-4 w-4" />
                    {creator.isFollowing ? "Following" : "Follow"}
                  </button>
                )}
              </header>

              <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
                {characters.map((card) => (
                  <CharacterCard card={card} key={card.id} />
                ))}
              </div>
              {characters.length === 0 && (
                <p className="mt-8 text-[13px] font-medium text-[rgb(170,170,170)]">
                  This creator has no public characters yet.
                </p>
              )}
            </>
          ) : (
            <p className="mt-8 text-[13px] font-medium text-[rgb(170,170,170)]">{status}</p>
          )}
        </section>
      </div>
      <SiteFooter />
      <MobileBottomNav activeHref="/" />
    </main>
  );
}

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}
