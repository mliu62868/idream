"use client";

import Link from "next/link";
import { Check, ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import {
  characterStyleFilterOptions,
  genderFilterOptions,
} from "@/lib/character-taxonomy";
import { categoryFilters } from "@/lib/ourdream-data";
import { cn } from "@/lib/utils";
import { AuthNav } from "./AuthNav";
import { MobileAppMenu } from "./MobileAppMenu";

const sortOptions = [
  { value: "for-you", label: "For You" },
  { value: "popular", label: "Popular" },
  { value: "newest", label: "Newest" },
  { value: "following", label: "Following" },
] as const;

// Mirrors the server's POPULAR_PERIODS: the label is the window the list is ranked by.
const periodOptions = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "all", label: "All time" },
] as const;

const ageOptions = [
  { value: "any", label: "Any Age" },
  { value: "18-24", label: "18-24" },
  { value: "25-34", label: "25-34" },
  { value: "35+", label: "35+" },
] as const;

function SelectPill({
  ariaLabel,
  name,
  onChange,
  options,
  value,
}: Readonly<{
  ariaLabel: string;
  name: string;
  onChange?: (value: string) => void;
  options: readonly { label: string; value: string }[];
  value: string;
}>) {
  return (
    <label className="relative inline-flex min-w-0 shrink-0">
      <select
        aria-label={ariaLabel}
        className="h-9 w-full min-w-0 appearance-none truncate rounded-full bg-[rgb(53,53,54)] pl-4 pr-8 text-[12px] font-medium leading-4 text-white outline-none transition-colors hover:bg-[rgb(62,62,63)] focus-visible:ring-2 focus-visible:ring-white/40 md:min-w-28 md:pr-9"
        name={name}
        onChange={(event) => onChange?.(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgb(170,170,170)]"
      />
    </label>
  );
}

export function TopControls({
  activeCategory = "All",
  categories = categoryFilters,
  query = "",
  sort = "popular",
  period = "month",
  gender = "female",
  style = "any",
  age = "any",
  onCategoryChange,
  onQueryChange,
  onSortChange,
  onPeriodChange,
  onGenderChange,
  onStyleChange,
  onAgeChange,
}: Readonly<{
  activeCategory?: string;
  categories?: readonly string[];
  query?: string;
  sort?: string;
  period?: string;
  gender?: string;
  style?: string;
  age?: string;
  onCategoryChange?: (category: string) => void;
  onQueryChange?: (query: string) => void;
  onSortChange?: (sort: string) => void;
  onPeriodChange?: (period: string) => void;
  onGenderChange?: (gender: string) => void;
  onStyleChange?: (style: string) => void;
  onAgeChange?: (age: string) => void;
}>) {
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const selectedFilters = [
    gender !== "any" ? genderFilterOptions.find((option) => option.value === gender)?.label : null,
    style !== "any" ? characterStyleFilterOptions.find((option) => option.value === style)?.label : null,
    age !== "any" ? ageOptions.find((option) => option.value === age)?.label : null,
  ].filter(Boolean).join(", ");
  const periodLabel = periodOptions.find((option) => option.value === period)?.label ?? "Month";
  const optionLabel = (value: string, label: string) =>
    value === "popular" ? `${label} · ${periodLabel}` : label;
  const sortLabel = optionLabel(sort, sortOptions.find((option) => option.value === sort)?.label ?? "For You");

  return (
    <>
      <header className="sticky top-0 z-40 h-14 w-full bg-[rgba(13,13,13,0.6)] backdrop-blur-xl">
        <div className="flex h-14 items-center justify-between gap-2 px-2 md:px-4">
          <MobileAppMenu activeHref="/" currentPath="/" />
          <div className="hidden min-w-0 flex-1 md:block" />
          <div className="ml-auto flex items-center gap-3">
            <Link
              aria-label="Compare upgrade plans"
              className="inline-flex min-h-11 items-center rounded-full px-2 text-[12px] font-semibold text-white/75 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 md:hidden"
              href="/upgrade"
            >
              Plans
            </Link>
            <AuthNav />
          </div>
        </div>
      </header>

      <section className="w-full px-2 pt-0 md:px-[60px] md:pt-[14px]">
        <label className="mb-3 flex h-10 items-center gap-2 rounded-full bg-[rgb(53,53,54)] px-4 text-[12px] font-medium leading-4 text-[rgb(170,170,170)] transition-shadow focus-within:ring-2 focus-within:ring-white/50 md:hidden">
          <Search className="h-4 w-4 shrink-0" />
          <input
            aria-label="Search characters"
            className="min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-[rgb(170,170,170)]"
            name="character-search-mobile"
            onChange={(event) => onQueryChange?.(event.target.value)}
            placeholder="Search characters"
            value={query}
          />
        </label>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 pb-2 md:flex md:flex-col xl:grid xl:grid-cols-[auto_minmax(240px,1fr)_auto] xl:items-center xl:gap-3 xl:pb-0">
          <div className="relative flex min-w-0 flex-wrap items-center justify-start gap-y-2">
            <button
              aria-expanded={sortMenuOpen}
              aria-label="Sort characters"
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-[rgb(53,53,54)] pl-4 pr-3 text-[12px] font-medium leading-4 text-white transition-colors hover:bg-[rgb(62,62,63)] focus-visible:outline-2 focus-visible:outline-offset-2 md:h-9"
              onClick={() => setSortMenuOpen((open) => !open)}
              type="button"
            >
              {sortLabel}
              <ChevronDown className="h-3.5 w-3.5 text-[rgb(170,170,170)]" />
            </button>
            {sortMenuOpen ? (
              <div
                aria-label="Sort options"
                className="absolute left-0 top-11 z-50 w-48 rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.38)]"
                role="menu"
              >
                {sortOptions.map((option) => {
                  const selected = option.value === sort;
                  return (
                    <button
                      className={cn(
                        "flex h-10 w-full items-center justify-between rounded-[9px] px-3 text-left text-[12px] font-bold text-[rgb(170,170,170)] transition-colors hover:bg-[rgb(36,36,36)] hover:text-white",
                        selected && "bg-[rgb(46,46,46)] text-white",
                      )}
                      key={option.value}
                      onClick={() => {
                        onSortChange?.(option.value);
                        setSortMenuOpen(false);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {optionLabel(option.value, option.label)}
                      {selected ? <Check className="h-3.5 w-3.5" /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {sort === "popular" ? (
              <div className="ml-2">
                <SelectPill
                  ariaLabel="Popular period"
                  name="period"
                  onChange={onPeriodChange}
                  options={periodOptions}
                  value={period}
                />
              </div>
            ) : null}
          </div>

          <label className="hidden h-9 items-center gap-2 rounded-full bg-[rgb(53,53,54)] px-4 text-[12px] font-medium leading-4 text-[rgb(170,170,170)] transition-shadow focus-within:ring-2 focus-within:ring-white/50 md:flex">
            <Search className="h-4 w-4" />
            <input
              aria-label="Search characters"
              className="min-w-0 flex-1 bg-transparent text-white outline-none placeholder:text-[rgb(170,170,170)]"
              name="character-search"
              onChange={(event) => onQueryChange?.(event.target.value)}
              placeholder="Search by name, tag or style"
              value={query}
            />
          </label>

          <button
            aria-controls="character-filters"
            aria-expanded={filtersOpen}
            aria-label={selectedFilters ? `Filters: ${selectedFilters}` : "Filters"}
            className="inline-flex min-h-11 max-w-48 items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] px-3 text-[12px] font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 md:hidden"
            onClick={() => setFiltersOpen((open) => !open)}
            type="button"
          >
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="truncate">{selectedFilters || "Filters"}</span>
          </button>

          <div
            className={cn("col-span-2 grid-cols-3 gap-2 md:grid xl:col-span-1 xl:flex xl:justify-end", filtersOpen ? "grid" : "hidden")}
            id="character-filters"
          >
            <SelectPill
              ariaLabel="Gender filter"
              name="gender"
              onChange={onGenderChange}
              options={genderFilterOptions}
              value={gender}
            />
            <SelectPill
              ariaLabel="Style filter"
              name="style"
              onChange={onStyleChange}
              options={characterStyleFilterOptions}
              value={style}
            />
            <SelectPill
              ariaLabel="Age filter"
              name="age"
              onChange={onAgeChange}
              options={ageOptions}
              value={age}
            />
          </div>
        </div>

        <div className="mt-2 flex gap-1 overflow-x-auto pb-3 md:mt-4 md:pb-0">
          {categories.map((filter) => (
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
