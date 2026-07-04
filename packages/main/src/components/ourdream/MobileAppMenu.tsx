"use client";

import Link from "next/link";
import { ExternalLink, Menu } from "lucide-react";
import { useId, useState } from "react";
import { primaryNavItems, secondaryNavItems } from "@/lib/ourdream-data";
import { cn } from "@/lib/utils";

const accountItems = [
  { label: "Profile", href: "/profile" },
  { label: "Upgrade", href: "/upgrade" },
];

function isActiveItem({
  activeHref,
  currentPath,
  href,
}: Readonly<{ activeHref: string; currentPath: string; href: string }>) {
  if (href === "/profile") return currentPath.startsWith("/profile");
  if (href === "/upgrade") return currentPath.startsWith("/upgrade");
  return href === activeHref;
}

export function MobileAppMenu({
  activeHref = "/",
  currentPath = "/",
}: Readonly<{ activeHref?: string; currentPath?: string }>) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menuItems = [...primaryNavItems, ...secondaryNavItems, ...accountItems];

  return (
    <div className="relative md:hidden">
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-label="Open navigation menu"
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[rgb(170,170,170)] transition-colors hover:bg-[rgb(36,36,36)] hover:text-white"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Menu aria-hidden="true" className="h-4 w-4" />
      </button>
      {open ? (
        <nav
          aria-label="App navigation"
          className="absolute left-0 top-12 z-50 grid w-[calc(100vw-1rem)] max-w-[358px] grid-cols-2 gap-2 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-3 shadow-[0_16px_40px_rgba(0,0,0,0.38)]"
          id={menuId}
        >
          {menuItems.map((item) => {
            const external = item.href.startsWith("http");
            const active = !external && isActiveItem({ activeHref, currentPath, href: item.href });
            const className = cn(
              "flex h-10 min-w-0 items-center justify-between gap-2 rounded-[10px] bg-[rgb(36,36,36)] px-3 text-[13px] font-bold leading-4 text-white transition-colors hover:bg-[rgb(53,53,54)]",
              active && "bg-[rgb(46,46,46)] ring-1 ring-white/20",
            );
            const content = (
              <>
                <span className="truncate">{item.label}</span>
                {external ? (
                  <ExternalLink
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-[rgb(170,170,170)]"
                  />
                ) : null}
              </>
            );

            if (external) {
              return (
                <a
                  className={className}
                  href={item.href}
                  key={item.href}
                  onClick={() => setOpen(false)}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {content}
                </a>
              );
            }

            return (
              <Link
                className={className}
                href={item.href}
                key={item.href}
                onClick={() => setOpen(false)}
              >
                {content}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
