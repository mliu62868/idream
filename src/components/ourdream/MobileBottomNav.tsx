import { Compass, MessageCircle, PlusSquare, Sparkles } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const items = [
  { label: "Explore", icon: Compass, href: "/" },
  { label: "Chat", icon: MessageCircle, href: "/chat" },
  { label: "Create", icon: PlusSquare, href: "/create" },
  { label: "Generate", icon: Sparkles, href: "/generate" },
];

export function MobileBottomNav({
  activeHref = "/",
}: Readonly<{ activeHref?: string }>) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 grid h-[64px] grid-cols-4 border-t border-[rgb(36,36,36)] bg-[rgb(13,13,13)] pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            key={item.label}
            className={cn(
              "flex flex-col items-center justify-center gap-1 text-[10px] font-medium leading-3 text-[rgb(114,113,112)]",
              item.href === activeHref && "text-white",
            )}
            href={item.href}
          >
            <Icon className="h-4 w-4" strokeWidth={2.2} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
