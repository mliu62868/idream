import Image from "next/image";
import { LoaderCircle } from "lucide-react";
import { characterCards } from "@/lib/ourdream-data";
import { CharacterCard } from "./CharacterCard";
import type { CharacterCardData } from "@/types/ourdream";

export function CharacterGrid({
  cards = characterCards,
  error = null,
  hasMore = false,
  loading = true,
  loadingMore = false,
  onLoadMore,
  onRetry,
}: Readonly<{
  cards?: CharacterCardData[];
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
            <CharacterCard card={card} />
            {index === 5 && (
              <article className="relative hidden aspect-[240/400] overflow-hidden rounded-[12px] bg-[rgb(36,36,36)] md:block">
                <Image
                  src="/images/ourdream/pride-card-female.webp"
                  alt="75% Pride Sale"
                  fill
                  sizes="210px"
                  className="object-cover"
                />
              </article>
            )}
          </div>
        ))}
      </div>

      {loading && (
        <div className="flex h-20 items-center justify-center gap-2 text-[12px] font-medium leading-4 text-[rgb(114,113,112)]">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading more characters...
        </div>
      )}

      {!loading && error && (
        <div className="flex min-h-44 flex-col items-center justify-center rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] px-6 py-8 text-center">
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
        <div className="flex min-h-64 flex-col items-center justify-center rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] px-6 py-12 text-center">
          <h2 className="text-[18px] font-black uppercase leading-6 text-white">
            No characters found
          </h2>
          <p className="mt-3 max-w-sm text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
            Try another search term, clear a category, or switch the gender,
            style, and age filters.
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
