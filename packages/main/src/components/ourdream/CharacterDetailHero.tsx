import Image from "next/image";
import type { ReactNode } from "react";
import { shouldBypassNextImageOptimizer } from "@/lib/image-delivery";
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
  const heroImage = character.heroImage ?? character.image;
  return (
    <div
      className="relative max-w-7xl overflow-hidden rounded-[24px] border border-white/10 bg-[rgb(20,20,20)]"
      data-testid="character-detail-renderer"
    >
      <div className="relative aspect-video min-h-[440px] bg-[rgb(36,36,36)]">
        <Image
          alt={`${character.title} character hero`}
          className="object-cover object-top"
          data-asset-id={character.heroImageAssetId ?? character.imageAssetId ?? undefined}
          data-testid="character-detail-hero-image"
          fill
          loading="eager"
          sizes="(min-width: 1280px) 1152px, 100vw"
          src={heroImage}
          unoptimized={shouldBypassNextImageOptimizer(heroImage)}
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,8,8,.88)_0%,rgba(8,8,8,.48)_48%,rgba(8,8,8,.08)_78%),linear-gradient(0deg,rgba(8,8,8,.84)_0%,transparent_58%)]" />
      </div>

      <div className="absolute inset-x-0 bottom-0 flex max-w-3xl flex-col justify-end p-6 md:inset-y-0 md:bottom-auto md:p-12">
        <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
          {character.style ?? "realistic"} companion
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
          <h1 className="text-[40px] font-black uppercase leading-[0.95] md:text-[72px]">
            {character.title}
          </h1>
          <span
            aria-label={`${character.age} years old`}
            className="pb-1 text-[28px] font-black leading-none text-white/80 md:pb-2 md:text-[42px]"
          >
            {character.age}
          </span>
        </div>
        <p className="mt-5 line-clamp-3 max-w-2xl text-[15px] font-medium leading-7 text-white/75 md:text-[17px]">
          {character.description}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {character.tags?.slice(0, 8).map((tag) => (
            <span
              className="rounded-full border border-white/10 bg-black/30 px-3 py-2 text-[12px] font-bold text-white/70 backdrop-blur-sm"
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
