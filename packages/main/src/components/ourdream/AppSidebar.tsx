import Image from "next/image";
import Link from "next/link";
import {
  Bot,
  CircleHelp,
  Compass,
  Crown,
  Disc3,
  Ellipsis,
  MessageCircle,
  Newspaper,
  PlusSquare,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
} from "lucide-react";
import { primaryNavItems, secondaryNavItems } from "@/lib/ourdream-data";
import { cn } from "@/lib/utils";

const primaryIcons = [
  PlusSquare,
  Compass,
  MessageCircle,
  Sparkles,
  Bot,
  Newspaper,
  UsersRound,
];

const secondaryIcons = [CircleHelp, ShieldCheck, Disc3, Ellipsis];

export function AppSidebar({
  activeHref = "/",
}: Readonly<{ activeHref?: string }>) {
  return (
    <aside className="hidden h-screen w-[220px] shrink-0 md:flex md:sticky md:top-0 md:z-30">
      <div className="flex h-screen w-[220px] flex-col overflow-hidden rounded-r-[24px] bg-[rgb(18,18,18)] px-0 pb-4 pt-2">
        <div className="flex h-11 items-center justify-between px-5">
          <Image
            src="/images/ourdream/ourdream-logo.svg"
            alt="ourdream.ai"
            width={121}
            height={14}
            className="h-3.5 w-auto object-contain"
            priority
          />
          <span className="h-4 w-4 rounded-[4px] border border-[rgb(114,113,112)]" />
        </div>

        <nav className="mt-4 flex flex-col gap-1 px-3">
          {primaryNavItems.map((item, index) => {
            const Icon = primaryIcons[index];
            return (
              <Link
                key={item.label}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-[10px] px-3 text-[12px] font-semibold leading-4 text-[rgb(170,170,170)] transition-colors hover:bg-[rgb(46,46,46)] hover:text-white",
                  item.href === activeHref && "bg-[rgb(46,46,46)] text-white",
                )}
                href={item.href}
              >
                <Icon className="h-4 w-4" strokeWidth={2.2} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="my-4 h-px bg-[rgb(36,36,36)]" />

        <nav className="flex flex-col gap-1 px-3">
          {secondaryNavItems.map((item, index) => {
            const Icon = secondaryIcons[index];
            return (
              <Link
                key={item.label}
                className="flex h-10 items-center gap-3 rounded-[10px] px-3 text-[12px] font-semibold leading-4 text-[rgb(170,170,170)] transition-colors hover:bg-[rgb(46,46,46)] hover:text-white"
                href={item.href}
              >
                <Icon className="h-4 w-4" strokeWidth={2.2} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto px-3">
          <div className="mb-3 h-px bg-[rgb(36,36,36)]" />
          <Link
            className="mb-3 flex h-9 items-center gap-3 rounded-[10px] px-3 text-[12px] font-semibold leading-4 text-[rgb(170,170,170)]"
            href="/profile"
          >
            <UserRound className="h-4 w-4" strokeWidth={2.2} />
            Profile
          </Link>
          <Link
            className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[12px] font-bold leading-4 text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.25)]"
            href="/upgrade"
          >
            <Crown className="h-4 w-4 fill-white" strokeWidth={2} />
            Upgrade
          </Link>
          <div className="mt-4 text-center text-[9px] font-medium uppercase leading-3 text-[rgb(114,113,112)]">
            <p>2026 OURDREAM.AI</p>
            <p>USA: Dream Studio USA, Inc.</p>
            <p>Cyprus: TEKTOPIA LTD (HE 473775)</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
