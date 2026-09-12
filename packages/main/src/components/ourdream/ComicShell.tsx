import Link from "next/link";
import type { ReactNode } from "react";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SiteFooter } from "./SiteFooter";

export function ComicShell({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
    <div className="flex min-h-screen">
      <AppSidebar activeHref="/community" />
      <div className="min-w-0 flex-1 px-4 pb-24 pt-8 md:px-12 md:pt-12">
        <nav aria-label="Comic navigation" className="mb-8 flex flex-wrap gap-5 text-sm font-semibold text-neutral-300">
          <Link className="hover:text-white" href="/comics">Comics</Link>
          <Link className="hover:text-white" href="/creator-studio/comics">Your Comics</Link>
          <Link className="hover:text-white" href="/profile?tab=media">Gallery</Link>
        </nav>
        {children}
        <SiteFooter />
      </div>
    </div>
    <MobileBottomNav activeHref="/community" />
  </main>;
}
