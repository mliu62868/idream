"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";
import { useState } from "react";

export function PromoToast() {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <aside className="fixed bottom-6 right-6 z-30 hidden w-[300px] rounded-[20px] bg-[rgb(46,46,46)] p-3 shadow-[2px_2px_8px_3px_rgba(0,0,0,0.25)] md:block">
      <div className="relative h-[178px] overflow-hidden rounded-[14px]">
        <Image
          src="/images/ourdream/promo-card-female.webp"
          alt="75% Pride Sale"
          fill
          sizes="276px"
          className="object-cover"
        />
        <button
          aria-label="Close promotion"
          className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-black/35 text-white"
          onClick={() => setVisible(false)}
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="px-1 pb-1 pt-3">
        <h2 className="text-[16px] font-black uppercase italic leading-4 text-white">
          75% Pride Sale
        </h2>
        <p className="mt-1 text-[12px] font-medium leading-4 text-[rgb(170,170,170)]">
          Celebrate Pride. Limited window - don&apos;t miss out!
        </p>
        <Link
          className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-full bg-white text-[12px] font-bold leading-4 text-[rgb(13,13,13)]"
          href="/upgrade"
        >
          Join Now
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </aside>
  );
}
