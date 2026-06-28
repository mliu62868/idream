"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { categoryFilters } from "@/lib/ourdream-data";
import type { CharacterCardData } from "@/types/ourdream";
import { CharacterGrid } from "./CharacterGrid";
import { TopControls } from "./TopControls";

const DEFAULT_LIMIT = 28;

type CharacterResponse = {
  ok: boolean;
  data?: {
    items: CharacterCardData[];
    nextCursor: string | null;
  };
};

export function ExploreWorkspace() {
  const [cards, setCards] = useState<CharacterCardData[]>([]);
  const [activeCategory, setActiveCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("popular");
  const [gender, setGender] = useState("female");
  const [style, setStyle] = useState("any");
  const [age, setAge] = useState("any");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  // Debounced mirror of `query`: drives requests/URL so typing doesn't fire one
  // fetch per keystroke. `query` stays the immediate value bound to the input.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const requestSerial = useRef(0);

  const params = useMemo(() => {
    const next = new URLSearchParams({ sort, limit: String(limit) });
    if (debouncedQuery.trim()) next.set("q", debouncedQuery.trim());
    if (activeCategory !== "All") next.set("tags", categoryParam(activeCategory));
    if (gender !== "any") next.set("gender", gender);
    if (style !== "any") next.set("style", style);
    if (age === "18-24") {
      next.set("age_min", "18");
      next.set("age_max", "24");
    }
    if (age === "25-34") {
      next.set("age_min", "25");
      next.set("age_max", "34");
    }
    if (age === "35+") next.set("age_min", "35");
    return next;
  }, [activeCategory, age, debouncedQuery, gender, limit, sort, style]);

  const loadCharacters = useCallback(
    async (cursor?: string) => {
      const serial = requestSerial.current + 1;
      requestSerial.current = serial;
      const requestParams = new URLSearchParams(params);
      if (cursor) requestParams.set("cursor", cursor);
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/v1/characters?${requestParams.toString()}`);
        if (!response.ok) throw new Error("Characters unavailable");
        const payload = (await response.json()) as CharacterResponse;
        if (serial !== requestSerial.current) return;
        const items = payload.data?.items ?? [];
        setCards((current) => (cursor ? [...current, ...items] : items));
        setNextCursor(payload.data?.nextCursor ?? null);
      } catch {
        if (serial !== requestSerial.current) return;
        setError(cursor ? "Could not load more characters." : "Could not load characters.");
      } finally {
        if (serial !== requestSerial.current) return;
        if (cursor) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [params],
  );

  useEffect(() => {
    // Rendered behind AgeGateBoundary, so acceptance is already guaranteed here —
    // load as soon as the URL-derived filters are parsed.
    if (!initialized) return;
    const timer = window.setTimeout(() => {
      void loadCharacters();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialized, loadCharacters]);

  // Commit the search box to `debouncedQuery` ~300ms after the last keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const initial = parseExploreSearchParams(window.location.search);
      setQuery(initial.query);
      setDebouncedQuery(initial.query);
      setSort(initial.sort);
      setGender(initial.gender);
      setStyle(initial.style);
      setAge(initial.age);
      setActiveCategory(initial.activeCategory);
      setLimit(initial.limit);
      setInitialized(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!initialized) return;
    const urlParams = new URLSearchParams();
    if (debouncedQuery.trim()) urlParams.set("q", debouncedQuery.trim());
    if (sort !== "popular") urlParams.set("sort", sort);
    if (gender !== "female") urlParams.set("gender", gender);
    if (style !== "any") urlParams.set("style", style);
    if (activeCategory !== "All") urlParams.set("tags", categoryParam(activeCategory));
    if (age === "18-24") {
      urlParams.set("age_min", "18");
      urlParams.set("age_max", "24");
    }
    if (age === "25-34") {
      urlParams.set("age_min", "25");
      urlParams.set("age_max", "34");
    }
    if (age === "35+") urlParams.set("age_min", "35");
    if (limit !== DEFAULT_LIMIT) urlParams.set("limit", String(limit));

    const nextSearch = urlParams.toString();
    const nextUrl = nextSearch ? `${window.location.pathname}?${nextSearch}` : window.location.pathname;
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [activeCategory, age, debouncedQuery, gender, initialized, limit, sort, style]);

  return (
    <>
      <TopControls
        activeCategory={activeCategory}
        age={age}
        gender={gender}
        onCategoryChange={setActiveCategory}
        onAgeChange={setAge}
        onGenderChange={setGender}
        onQueryChange={setQuery}
        onSortChange={setSort}
        onStyleChange={setStyle}
        query={query}
        sort={sort}
        style={style}
      />
      <div className="pt-2 md:pt-6">
        <CharacterGrid
          cards={cards}
          error={error}
          hasMore={Boolean(nextCursor)}
          loading={!initialized || loading}
          loadingMore={loadingMore}
          onLoadMore={() => {
            if (nextCursor) void loadCharacters(nextCursor);
          }}
          onRetry={() => void loadCharacters()}
        />
      </div>
    </>
  );
}

function parseExploreSearchParams(search: string) {
  const params = new URLSearchParams(search);
  return {
    activeCategory: categoryFromParam(params.get("tags")),
    age: ageFromParams(params),
    gender: enumParam(params.get("gender"), ["female", "male", "trans", "any"], "female"),
    limit: clampLimit(params.get("limit")),
    query: params.get("q") ?? "",
    sort: enumParam(params.get("sort"), ["popular", "newest"], "popular"),
    style: enumParam(params.get("style"), ["any", "realistic", "anime", "hybrid"], "any"),
  };
}

function categoryParam(category: string) {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function categoryFromParam(value: string | null) {
  if (!value) return "All";
  const normalized = categoryParam(value);
  return (
    characterCategoryValues.find((category) => categoryParam(category) === normalized) ?? "All"
  );
}

const characterCategoryValues = [
  ...categoryFilters,
] as const;

function ageFromParams(params: URLSearchParams) {
  const min = params.get("age_min");
  const max = params.get("age_max");
  if (min === "18" && max === "24") return "18-24";
  if (min === "25" && max === "34") return "25-34";
  if (min === "35") return "35+";
  return "any";
}

function enumParam<T extends string>(value: string | null, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(60, Math.max(1, parsed));
}
