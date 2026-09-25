import Link from "next/link";
import { AppSearch } from "./AppSearch";
import { AuthNav } from "./AuthNav";
import { MobileAppMenu } from "./MobileAppMenu";

// SPEC: the one top bar every app page shares — mobile menu, search, sign-in.
// INTENT: pages that rendered only the sidebar (character detail, Comics,
// creator pages, group chats, 404) left a visitor arriving from a shared link
// with no way to log in or search.
export function AppTopbar({
  activeHref,
  currentPath,
}: Readonly<{ activeHref: string; currentPath: string }>) {
  return (
    <header className="sticky top-0 z-40 h-14 w-full bg-[rgba(13,13,13,0.62)] backdrop-blur-xl">
      <div className="flex h-14 items-center justify-between gap-3 px-4 md:px-[60px]">
        <MobileAppMenu activeHref={activeHref} currentPath={currentPath} />
        <Link className="hidden md:block" href="/">
          <span className="text-[24px] font-black tracking-tight text-white">iDream</span>
        </Link>
        <AppSearch />
        <div className="flex items-center gap-3">
          <AuthNav />
        </div>
      </div>
    </header>
  );
}
