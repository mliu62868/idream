import Image from "next/image";
import Link from "next/link";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { characterCards } from "@/lib/ourdream-data";
import { CharacterCard } from "./CharacterCard";
import type { CharacterCardData } from "@/types/ourdream";

export function CharacterGrid({
  cards = characterCards,
  emptyDescription = "Try another search term, clear a category, or switch the gender, style, and age filters.",
  emptyTitle = "No characters found",
  error = null,
  hasMore = false,
  loading = true,
  loadingMore = false,
  onLoadMore,
  onRetry,
}: Readonly<{
  cards?: CharacterCardData[];
  emptyDescription?: string;
  emptyTitle?: string;
  error?: string | null;
  hasMore?: boolean;
  loading?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onRetry?: () => void;
}>) {
  return (
    <section className="w-full px-2 md:px-[60px]">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5 md:gap-3">
        {cards.map((card, index) => (
          <div key={card.id} className="contents">
            <CharacterCard card={card} imageLoading={index < 10 ? "eager" : "lazy"} />
            {index === 5 && (
              <Link
                aria-label="Pride offer - view plans"
                className="group relative hidden aspect-[240/400] overflow-hidden rounded-[12px] bg-[rgb(36,36,36)] md:block"
                href="/upgrade"
              >
                <Image
                  alt=""
                  className="object-cover"
                  fill
                  loading="eager"
                  sizes="(max-width: 767px) 0px, calc((100vw - 168px) / 5)"
                  src="/images/ourdream/promo-card-female.webp"
                />
                <span className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.78),rgba(0,0,0,.18)_60%,transparent)]" />
                <span className="absolute inset-x-0 bottom-0 p-4">
                  <span className="block text-[24px] font-black uppercase leading-6 text-white">
                    Pride offer
                  </span>
                  <span className="mt-2 block text-[12px] font-bold leading-4 text-white/80">
                    Upgrade for more dreamcoins and longer chats.
                  </span>
                  <span className="mt-4 inline-flex h-9 items-center gap-2 rounded-full bg-white px-4 text-[12px] font-black text-[rgb(13,13,13)]">
                    View plans
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </span>
              </Link>
            )}
          </div>
        ))}
      </div>

      {loading && (
        <div
          aria-live="polite"
          className="flex h-20 items-center justify-center gap-2 text-[12px] font-medium leading-4 text-[rgb(114,113,112)]"
          data-testid="character-grid-status"
          role="status"
        >
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading more characters...
        </div>
      )}

      {!loading && error && (
        <div
          aria-live="assertive"
          className="flex min-h-44 flex-col items-center justify-center rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] px-6 py-8 text-center"
          data-testid="character-grid-status"
          role="alert"
        >
          <h2 className="text-[16px] font-black uppercase leading-6 text-white">
            {error}
          </h2>
          <button
            className="mt-4 inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)]"
            onClick={onRetry}
            type="button"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && cards.length === 0 && (
        <div
          aria-live="polite"
          className="flex min-h-64 flex-col items-center justify-center rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] px-6 py-12 text-center"
          data-testid="character-grid-status"
          role="status"
        >
          <h2 className="text-[18px] font-black uppercase leading-6 text-white">
            {emptyTitle}
          </h2>
          <p className="mt-3 max-w-sm text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
            {emptyDescription}
          </p>
        </div>
      )}

      {!loading && !error && hasMore && (
        <div className="flex h-24 items-center justify-center">
          <button
            className="inline-flex h-11 min-w-44 items-center justify-center rounded-full bg-white px-6 text-[13px] font-black text-[rgb(13,13,13)] disabled:opacity-60"
            disabled={loadingMore}
            onClick={onLoadMore}
            type="button"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}
