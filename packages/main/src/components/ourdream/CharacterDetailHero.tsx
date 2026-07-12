import Image from "next/image";
import type { ReactNode } from "react";
import type { CharacterCardData } from "@/types/ourdream";

export type CharacterDetailPresentationData = CharacterCardData & {
  tags?: Array<{ label: string; slug: string }>;
  liked?: boolean;
  style?: string;
  gender?: string;
};

export function CharacterDetailHero({
  character,
  actions,
}: Readonly<{
  character: CharacterDetailPresentationData;
  actions?: ReactNode;
}>) {
  return (
    <div className="grid max-w-6xl gap-6 md:grid-cols-[380px_1fr]" data-testid="character-detail-renderer">
      <div className="relative aspect-[240/400] overflow-hidden rounded-[20px] bg-[rgb(36,36,36)]">
        <Image
          alt=""
          className="object-cover object-top"
          fill
          loading="eager"
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
        {actions}
      </div>
    </div>
  );
}

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}
