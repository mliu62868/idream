import Image from "next/image";
import type { CharacterCardData } from "@/types/ourdream";
import {
  ChatBubbleIcon,
  HeartOutlineIcon,
  SparkleBadgeIcon,
} from "@/components/icons";

export function CharacterCard({ card }: Readonly<{ card: CharacterCardData }>) {
  return (
    <article className="group relative aspect-[240/400] w-full cursor-pointer overflow-hidden rounded-[12px] bg-[rgb(36,36,36)] transition-transform duration-200 ease-out hover:scale-[1.012]">
      {card.vivid && (
        <div className="pointer-events-none absolute right-3 top-2 z-10 -skew-x-6">
          <span className="inline-flex items-center gap-1 rounded-[8px] bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] px-2 py-1 text-[11px] font-black uppercase italic leading-[14px] text-white">
            <SparkleBadgeIcon className="h-3 w-3 skew-x-6" />
            <span className="skew-x-6">vivid</span>
          </span>
        </div>
      )}

      <Image
        src={card.image}
        alt=""
        fill
        sizes="(max-width: 767px) 183px, 210px"
        className="object-cover object-top"
      />
      <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.72),rgba(0,0,0,.58)_24%,rgba(0,0,0,.22)_48%,rgba(0,0,0,0)_70%)]" />

      <div className="absolute inset-x-0 bottom-0 p-2">
        <div className="min-w-0">
          <h2 className="line-clamp-2 text-[16px] font-bold leading-[18px] text-white">
            {card.title}
            <span className="ml-2 whitespace-nowrap text-[14px] font-bold leading-[16px]">
              {card.age}
            </span>
          </h2>
          <p className="line-clamp-2 pt-0.5 text-[12px] font-medium leading-4 text-[rgb(170,170,170)]">
            {card.description}
          </p>
        </div>

        <div className="mt-2 flex items-center gap-2 text-[10px] font-medium leading-3 text-white">
          <span className="flex items-center gap-1">
            <HeartOutlineIcon className="h-3.5 w-3.5" />
            {card.likes}
          </span>
          <span className="flex items-center gap-1">
            <ChatBubbleIcon className="h-3.5 w-3.5" />
            {card.chats}
          </span>
          <span className="ml-auto min-w-0 truncate">{card.creator}</span>
        </div>
      </div>
    </article>
  );
}
