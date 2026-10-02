import Link from "next/link";
import type { ReactNode } from "react";
import { AppSidebar } from "./AppSidebar";
import { AppTopbar } from "./AppTopbar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SiteFooter } from "./SiteFooter";

export function PackShell({ children, path = "/packs" }: { children: ReactNode; path?: string }) {
  return <main className="min-h-screen bg-[rgb(13,13,13)] text-white"><div className="flex min-h-screen"><AppSidebar activeHref="/packs" /><div className="min-w-0 flex-1"><AppTopbar activeHref="/packs" currentPath={path} /><div className="px-4 pb-24 pt-8 md:px-12 md:pt-12">
    <nav aria-label="Pack navigation" className="mb-8 flex flex-wrap gap-5 text-sm font-semibold text-neutral-300"><Link href="/packs">Browse free Packs</Link><Link href="/packs?scope=mine">Your Packs</Link><Link href="/packs?scope=claimed">Claimed Packs</Link><Link href="/custom?tab=media">Gallery</Link></nav>{children}<SiteFooter />
  </div></div></div><MobileBottomNav activeHref="/custom" /></main>;
}
