import Image from "next/image";
import { LoaderCircle } from "lucide-react";
import { characterCards } from "@/lib/ourdream-data";
import { CharacterCard } from "./CharacterCard";
import type { CharacterCardData } from "@/types/ourdream";

export function CharacterGrid({
  cards = characterCards,
  loading = true,
}: Readonly<{ cards?: CharacterCardData[]; loading?: boolean }>) {
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
    </section>
  );
}
