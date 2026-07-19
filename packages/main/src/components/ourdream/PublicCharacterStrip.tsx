"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { shouldBypassNextImageOptimizer } from "@/lib/image-delivery";
import { parseCharacterListResponse } from "@/lib/public-api-contracts";
import type { CharacterCardData } from "@/types/ourdream";
import { useAgeGateAccess } from "./AgeGateBoundary";

type StripState = "loading" | "ready" | "error";

export function PublicCharacterStrip() {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [state, setState] = useState<StripState>("loading");

  useEffect(() => {
    if (!ageGateAccepted) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/v1/characters?sort=for-you&limit=4")
        .then(async (response) => {
          if (!response.ok) throw new Error("characters unavailable");
          const payload = parseCharacterListResponse(await response.json());
          setCharacters(payload.items.slice(0, 4));
          setState("ready");
        })
        .catch(() => {
          setCharacters([]);
          setState("error");
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted]);

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      {state === "loading" ? (
        <p
          aria-live="polite"
          className="rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-8 text-center text-[13px] font-medium text-[rgb(170,170,170)]"
          data-testid="public-character-strip-status"
          role="status"
        >
          Loading public characters...
        </p>
      ) : null}
      {state === "ready" && characters.length === 0 ? (
        <div
          aria-live="polite"
          className="rounded-[18px] border border-white/10 bg-[rgb(18,18,18)] p-6 md:flex md:items-center md:justify-between md:gap-8 md:p-8"
          data-testid="public-character-strip-status"
          role="status"
        >
          <div className="max-w-2xl">
            <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
              Public characters
            </p>
            <h2 className="mt-2 text-[26px] font-black uppercase leading-8 text-white">
              The public showcase is being curated
            </h2>
            <p className="mt-3 text-[14px] font-medium leading-6 text-[rgb(170,170,170)]">
              You can still shape a private character now, then return when new
              public companions are ready to explore.
            </p>
          </div>
          <div className="mt-5 flex shrink-0 flex-wrap gap-2 md:mt-0">
            <Link
              className="inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
              href="/create"
            >
              Create a character
            </Link>
            <Link
              className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-5 text-[13px] font-black text-white"
              href="/"
            >
              Browse Explore
            </Link>
          </div>
        </div>
      ) : null}
      {state === "error" ? (
        <div
          aria-live="assertive"
          className="rounded-[18px] border border-white/10 bg-[rgb(18,18,18)] p-6 md:flex md:items-center md:justify-between md:gap-8 md:p-8"
          data-testid="public-character-strip-status"
          role="alert"
        >
          <div className="max-w-2xl">
            <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
              Public characters
            </p>
            <h2 className="mt-2 text-[26px] font-black uppercase leading-8 text-white">
              Character showcase is temporarily unavailable
            </h2>
            <p className="mt-3 text-[14px] font-medium leading-6 text-[rgb(170,170,170)]">
              The catalog could not be loaded, but character creation and the
              rest of this guide are still available.
            </p>
          </div>
          <Link
            className="mt-5 inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)] md:mt-0"
            href="/create"
          >
            Create a character
          </Link>
        </div>
      ) : null}
      {state === "ready" && characters.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-4">
          {characters.map((card, index) => (
            <Link
              className="group overflow-hidden rounded-[14px] border border-white/10 bg-[rgb(18,18,18)]"
              data-testid="public-character-strip-card"
              href={`/characters/${card.id}`}
              key={card.id}
            >
              <div className="relative aspect-[240/260] overflow-hidden">
                <Image
                  alt={card.title}
                  className="object-cover object-top transition-transform duration-200 group-hover:scale-[1.03]"
                  fill
                  loading={index === 0 ? "eager" : "lazy"}
                  sizes="(max-width: 767px) 50vw, 220px"
                  src={card.image}
                  unoptimized={shouldBypassNextImageOptimizer(card.image)}
                />
                <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.78),rgba(0,0,0,.18)_58%,transparent)]" />
                <div className="absolute inset-x-0 bottom-0 p-3">
                  <h3 className="line-clamp-2 text-[17px] font-bold leading-5">
                    {card.title}
                    <span className="ml-2 text-[14px]">{card.age}</span>
                  </h3>
                  <p className="mt-1 text-[12px] font-medium leading-4 text-[rgb(170,170,170)]">
                    {typeof card.chatsCount === "number" && card.chatsCount > 0
                      ? `${card.chats} chats`
                      : card.source === "official"
                        ? "Official character"
                        : "New public character"}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}
