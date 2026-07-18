"use client";

import Link from "next/link";
import { ArrowLeft, Flag, Heart, MessageCircle, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  parseCharacterDetailResponse,
  parseCharacterLikeResponse,
  parseChatSessionCreateResponse,
  parseReportResponse,
  type PublicCharacterDetail,
} from "@/lib/public-api-contracts";
import {
  CharacterDetailHero,
} from "./CharacterDetailHero";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SiteFooter } from "./SiteFooter";

type CharacterDetail = PublicCharacterDetail;

export function CharacterDetailClient({ id }: Readonly<{ id: string }>) {
  return <CharacterDetailView id={id} key={id} />;
}

function CharacterDetailView({ id }: Readonly<{ id: string }>) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const [character, setCharacter] = useState<CharacterDetail>();
  const [status, setStatus] = useState("Loading character...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ageGateAccepted) return;
    const controller = new AbortController();
    fetch(`/api/v1/characters/${id}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          // Distinguish failure categories: 403 is the age gate, 404 is a
          // genuine missing character, anything else is a load/server error.
          if (response.status === 403) {
            setStatus("Accept the age gate or sign in to view this character.");
          } else if (response.status === 404) {
            setStatus("This character could not be found.");
          } else {
            setStatus("Could not load this character. Please try again.");
          }
          return;
        }
        const payload = parseCharacterDetailResponse(await response.json());
        setCharacter(payload.character);
        setStatus("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("Could not load this character. Please try again.");
      });
    return () => controller.abort();
  }, [ageGateAccepted, id]);

  async function startChat() {
    if (!character) return;
    setBusy(true);
    setStatus("");
    try {
      const entry = new URLSearchParams(window.location.search);
      const entryExposureId = entry.get("entryExposureId");
      const journeyId = entry.get("journeyId");
      const placementId = entry.get("placementId");
      const completeAttribution = entryExposureId && journeyId && placementId
        ? { entryExposureId, journeyId, placementId }
        : {};
      const response = await fetch("/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: character.id, ...completeAttribution }),
      });
      if (response.status === 401) {
        window.location.assign(signupUrlForCurrentCharacter());
        return;
      }
      if (!response.ok) {
        setStatus("Could not start chat. Please try again.");
        return;
      }
      const payload = parseChatSessionCreateResponse(await response.json());
      window.location.href = `/chat/${payload.session.id}`;
    } catch {
      setStatus("Could not start chat. Please try again.");
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
        window.location.assign(signupUrlForCurrentCharacter());
        return;
      }
      if (!response.ok) {
        setStatus("Could not save your like. Please try again.");
        return;
      }
      const payload = parseCharacterLikeResponse(await response.json());
      setCharacter({ ...character, liked: payload.liked });
      setStatus(payload.liked ? "Character liked." : "Character like removed.");
    } catch {
      setStatus("Could not save your like. Please try again.");
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
        window.location.assign(signupUrlForCurrentCharacter());
        return;
      }
      if (!response.ok) {
        setStatus("Could not submit the report. Please try again.");
        return;
      }
      parseReportResponse(await response.json());
      setStatus("Report submitted for review.");
    } catch {
      setStatus("Could not submit the report. Please try again.");
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
            <div className="mt-6">
              <CharacterDetailHero
                actions={<div className="mt-7 flex flex-wrap gap-3" data-testid="character-detail-actions">
                  <button
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-6 text-[14px] font-black text-[rgb(13,13,13)] disabled:opacity-70"
                    disabled={busy}
                    onClick={startChat}
                    type="button"
                  >
                    <MessageCircle className="h-4 w-4" />
                    Chat
                  </button>
                  <Link
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[rgb(253,95,194)] px-5 text-[14px] font-black text-[rgb(13,13,13)]"
                    href={`/generate?characterId=${encodeURIComponent(character.id)}`}
                  >
                    <Sparkles className="h-4 w-4" />
                    Generate
                  </Link>
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
                </div>}
                character={character}
              />
              {status && (
                  <p
                    aria-live="polite"
                    className="mt-5 text-[13px] font-medium text-[rgb(170,170,170)]"
                    data-testid="character-detail-status"
                    role="status"
                  >
                    {status}
                  </p>
              )}
            </div>
          ) : (
            <div
              aria-live="polite"
              className="mt-10 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-8 text-[14px] text-[rgb(170,170,170)]"
              data-testid="character-detail-status"
              role="status"
            >
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


function signupUrlForCurrentCharacter() {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `/signup?next=${encodeURIComponent(next)}`;
}
