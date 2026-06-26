"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Flag, Heart, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { CharacterCardData } from "@/types/ourdream";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SiteFooter } from "./SiteFooter";

type CharacterDetailResponse = {
  ok: boolean;
  data?: {
    character: CharacterDetail;
  };
};

type CharacterDetail = CharacterCardData & {
  tags?: Array<{ label: string; slug: string }>;
  liked?: boolean;
  style?: string;
  gender?: string;
};

export function CharacterDetailClient({ id }: Readonly<{ id: string }>) {
  const [character, setCharacter] = useState<CharacterDetail>();
  const [status, setStatus] = useState("Loading character...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/v1/characters/${id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Character unavailable");
        return (await response.json()) as CharacterDetailResponse;
      })
      .then((payload) => {
        if (payload.data?.character) {
          setCharacter(payload.data.character);
          setStatus("");
        }
      })
      .catch(() => setStatus("Accept the age gate or sign in to view this character."));
  }, [id]);

  async function startChat() {
    if (!character) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: character.id }),
      });
      if (response.status === 401) {
        window.location.href = "/signup";
        return;
      }
      if (!response.ok) {
        setStatus("Could not start chat. Please try again.");
        return;
      }
      const payload = (await response.json()) as {
        data?: { session?: { id: string } };
      };
      if (payload.data?.session?.id) {
        window.location.href = `/chat/${payload.data.session.id}`;
      }
    } finally {
      setBusy(false);
    }
  }

  async function likeCharacter() {
    if (!character) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`/api/v1/characters/${character.id}/like`, {
        method: "POST",
      });
      if (response.status === 401) {
        window.location.href = "/signup";
        return;
      }
      if (!response.ok) {
        setStatus("Could not save your like. Please try again.");
        return;
      }
      setCharacter({ ...character, liked: true });
      setStatus("Character liked.");
    } finally {
      setBusy(false);
    }
  }

  async function reportCharacter() {
    if (!character) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`/api/v1/characters/${character.id}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category: "other_prohibited_content",
          description: "User submitted from character detail.",
        }),
      });
      if (response.status === 401) {
        window.location.href = "/signup";
        return;
      }
      if (!response.ok) {
        setStatus("Could not submit the report. Please try again.");
        return;
      }
      setStatus("Report submitted for review.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref="/" />
        <section className="min-w-0 flex-1 px-4 py-8 pb-24 md:px-[60px] md:py-12">
          <Link
            className="inline-flex items-center gap-2 text-[13px] font-bold text-[rgb(170,170,170)] hover:text-white"
            href="/"
          >
            <ArrowLeft className="h-4 w-4" />
            Explore
          </Link>

          {character ? (
            <div className="mt-6 grid max-w-6xl gap-6 md:grid-cols-[380px_1fr]">
              <div className="relative aspect-[240/400] overflow-hidden rounded-[20px] bg-[rgb(36,36,36)]">
                <Image
                  alt=""
                  className="object-cover object-top"
                  fill
                  priority
                  sizes="380px"
                  src={character.image}
                  unoptimized={isPrivateMediaUrl(character.image)}
                />
                <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.72),transparent_55%)]" />
              </div>

              <div className="flex flex-col justify-center">
                <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
                  {character.style ?? "realistic"} companion
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
                  <h1 className="text-[44px] font-black uppercase leading-[0.95] md:text-[72px]">
                    {character.title}
                  </h1>
                  <span
                    aria-label={`${character.age} years old`}
                    className="pb-1 text-[28px] font-black leading-none text-white/80 md:pb-2 md:text-[42px]"
                  >
                    {character.age}
                  </span>
                </div>
                <p className="mt-5 max-w-2xl text-[15px] font-medium leading-7 text-[rgb(170,170,170)] md:text-[17px]">
                  {character.description}
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {character.tags?.slice(0, 8).map((tag) => (
                    <span
                      className="rounded-full bg-[rgb(36,36,36)] px-3 py-2 text-[12px] font-bold text-[rgb(170,170,170)]"
                      key={tag.slug}
                    >
                      {tag.label}
                    </span>
                  ))}
                </div>
                <div className="mt-7 flex flex-wrap gap-3">
                  <button
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[14px] font-black text-[rgb(13,13,13)] disabled:opacity-70"
                    disabled={busy}
                    onClick={startChat}
                    type="button"
                  >
                    <MessageCircle className="h-4 w-4" />
                    Chat
                  </button>
                  <button
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
                    disabled={busy}
                    onClick={likeCharacter}
                    type="button"
                  >
                    <Heart className="h-4 w-4" />
                    {character.liked ? "Liked" : "Like"}
                  </button>
                  <button
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-5 text-[14px] font-bold text-white"
                    disabled={busy}
                    onClick={reportCharacter}
                    type="button"
                  >
                    <Flag className="h-4 w-4" />
                    Report
                  </button>
                </div>
                {status && (
                  <p className="mt-5 text-[13px] font-medium text-[rgb(170,170,170)]">
                    {status}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-10 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-8 text-[14px] text-[rgb(170,170,170)]">
              {status}
            </div>
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
