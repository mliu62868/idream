"use client";

import { useEffect, useMemo, useState } from "react";
import { characterCards } from "@/lib/ourdream-data";
import type { CharacterCardData } from "@/types/ourdream";
import { CharacterGrid } from "./CharacterGrid";
import { TopControls } from "./TopControls";

type CharacterResponse = {
  ok: boolean;
  data?: {
    items: CharacterCardData[];
  };
};

export function ExploreWorkspace() {
  const [cards, setCards] = useState<CharacterCardData[]>(characterCards);
  const [activeCategory, setActiveCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("popular");
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);

  const params = useMemo(() => {
    const next = new URLSearchParams({ sort, limit: "28" });
    if (query.trim()) next.set("q", query.trim());
    if (activeCategory !== "All") next.set("tags", activeCategory);
    return next;
  }, [activeCategory, query, sort]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadCharacters() {
      setLoading(true);
      const response = await fetch(`/api/v1/characters?${params.toString()}`, {
        signal: controller.signal,
      });
      const payload = response.ok
        ? ((await response.json()) as CharacterResponse)
        : null;

      try {
        if (payload?.data?.items) setCards(payload.data.items);
      } finally {
        setLoading(false);
      }
    }

    loadCharacters().catch(() => setLoading(false));

    return () => controller.abort();
  }, [params, reloadToken]);

  useEffect(() => {
    function reload() {
      setReloadToken((value) => value + 1);
    }

    window.addEventListener("idream-age-gate-accepted", reload);
    return () => window.removeEventListener("idream-age-gate-accepted", reload);
  }, []);

  return (
    <>
      <TopControls
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        onQueryChange={setQuery}
        onSortChange={setSort}
        query={query}
        sort={sort}
      />
      <div className="pt-2 md:pt-6">
        <CharacterGrid cards={cards} loading={loading} />
      </div>
    </>
  );
}
