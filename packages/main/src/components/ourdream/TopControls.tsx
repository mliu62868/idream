"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronDown, Menu, Search } from "lucide-react";
import { useState } from "react";
import { categoryFilters } from "@/lib/ourdream-data";
import { cn } from "@/lib/utils";
import { AuthNav } from "./AuthNav";

const mobileMenuItems = [
  { label: "Create", href: "/create" },
  { label: "Explore", href: "/" },
  { label: "Chat", href: "/chat" },
  { label: "Generate", href: "/generate" },
  { label: "My AI", href: "/custom" },
  { label: "Feed", href: "/feed" },
  { label: "Community", href: "/community" },
  { label: "Help Desk", href: "/helpdesk" },
  { label: "Upgrade", href: "/upgrade" },
];

function Pill({
  ariaLabel,
  children,
  className,
  onClick,
}: Readonly<{
  ariaLabel?: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}>) {
  return (
    <button
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[rgb(53,53,54)] pl-4 pr-3 text-[12px] font-medium leading-4 text-white transition-colors hover:bg-[rgb(62,62,63)]",
        className,
      )}
      onClick={onClick}
      type="button"
    >
      {children}
      <ChevronDown className="h-3.5 w-3.5 text-[rgb(170,170,170)]" />
    </button>
  );
}

export function TopControls({
  activeCategory = "All",
  query = "",
  sort = "popular",
  gender = "female",
  style = "any",
  age = "any",
  onCategoryChange,
  onQueryChange,
  onSortChange,
  onGenderChange,
  onStyleChange,
  onAgeChange,
}: Readonly<{
  activeCategory?: string;
  query?: string;
  sort?: string;
  gender?: string;
  style?: string;
  age?: string;
  onCategoryChange?: (category: string) => void;
  onQueryChange?: (query: string) => void;
  onSortChange?: (sort: string) => void;
  onGenderChange?: (gender: string) => void;
  onStyleChange?: (style: string) => void;
  onAgeChange?: (age: string) => void;
}>) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const sortLabel = sort === "newest" ? "Newest" : "Popular · Month";
  const genderLabel = gender === "any" ? "Any Gender" : titleCase(gender);
  const styleLabel = style === "any" ? "Any Style" : titleCase(style);
  const ageLabel =
    age === "18-24" ? "18-24" : age === "25-34" ? "25-34" : age === "35+" ? "35+" : "Any Age";

  return (
    <>
      <header className="sticky top-0 z-40 h-14 w-full bg-[rgba(13,13,13,0.6)] backdrop-blur-xl">
        <div className="flex h-14 items-center justify-between gap-2 px-2 md:px-4">
          <button
            aria-expanded={mobileMenuOpen}
            aria-label="Open navigation menu"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[rgb(170,170,170)] md:hidden"
            onClick={() => setMobileMenuOpen((open) => !open)}
            type="button"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="hidden min-w-0 flex-1 md:block" />
          <div className="ml-auto flex items-center gap-3">
            <AuthNav />
          </div>
        </div>
        {mobileMenuOpen ? (
          <nav className="absolute left-2 right-2 top-14 grid grid-cols-2 gap-2 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-3 shadow-[0_16px_40px_rgba(0,0,0,0.38)] md:hidden">
            {mobileMenuItems.map((item) => (
              <Link
                className="rounded-[10px] bg-[rgb(36,36,36)] px-3 py-3 text-[13px] font-bold text-white"
                href={item.href}
                key={item.href}
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>

      <section className="w-full px-2 pt-0 md:px-[60px] md:pt-[14px]">
        <div className="mb-3 overflow-hidden md:hidden">
          <Image
            src="/images/ourdream/pride-banner-female.webp"
            alt="Pride Sale - Upgrade Now"
            width={800}
            height={160}
            className="h-[52px] w-full object-cover"
            priority
          />
        </div>

        <label className="mb-3 flex h-10 items-center gap-2 rounded-full bg-[rgb(53,53,54)] px-4 text-[12px] font-medium leading-4 text-[rgb(170,170,170)] md:hidden">
          <Search className="h-4 w-4 shrink-0" />
          <input
            aria-label="Search characters"
            className="min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-[rgb(170,170,170)]"
            onChange={(event) => onQueryChange?.(event.target.value)}
            placeholder="Search characters"
            value={query}
          />
        </label>

        <div className="flex items-center gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-[1fr_320px_1fr] md:overflow-visible md:pb-0">
          <div className="flex justify-start">
            <button
              aria-label="Sort characters"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[rgb(53,53,54)] pl-4 pr-3 text-[12px] font-medium leading-4 text-white transition-colors hover:bg-[rgb(62,62,63)]"
              onClick={() => onSortChange?.(sort === "newest" ? "popular" : "newest")}
              type="button"
            >
              {sortLabel}
              <ChevronDown className="h-3.5 w-3.5 text-[rgb(170,170,170)]" />
            </button>
          </div>

          <label className="hidden h-9 items-center gap-2 rounded-full bg-[rgb(53,53,54)] px-4 text-[12px] font-medium leading-4 text-[rgb(170,170,170)] md:flex">
            <Search className="h-4 w-4" />
            <input
              aria-label="Search characters"
              className="min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-[rgb(170,170,170)]"
              onChange={(event) => onQueryChange?.(event.target.value)}
              placeholder="Try 'Busty blonde' or 'Petite asian'"
              value={query}
            />
          </label>

          <div className="flex justify-start gap-2 md:justify-end">
            <Pill
              ariaLabel="Gender filter"
              onClick={() => onGenderChange?.(nextValue(gender, ["female", "male", "trans", "any"]))}
            >
              {genderLabel}
            </Pill>
            <Pill
              ariaLabel="Style filter"
              onClick={() => onStyleChange?.(nextValue(style, ["any", "realistic", "anime", "hybrid"]))}
            >
              {styleLabel}
            </Pill>
            <Pill
              ariaLabel="Age filter"
              onClick={() => onAgeChange?.(nextValue(age, ["any", "18-24", "25-34", "35+"]))}
            >
              {ageLabel}
            </Pill>
          </div>
        </div>

        <div className="mt-2 flex gap-1 overflow-x-auto pb-3 md:mt-4 md:pb-0">
          {categoryFilters.map((filter) => (
            <button
              key={filter}
              onClick={() => onCategoryChange?.(filter)}
              className={cn(
                "flex h-9 shrink-0 items-center rounded-full px-3 text-[12px] font-medium leading-4 transition-colors",
                filter === activeCategory
                  ? "bg-[rgb(46,46,46)] text-white"
                  : "text-[rgb(170,170,170)] hover:bg-[rgb(36,36,36)] hover:text-white",
              )}
              type="button"
            >
              {filter}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function nextValue(current: string, values: string[]) {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] ?? values[0];
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
