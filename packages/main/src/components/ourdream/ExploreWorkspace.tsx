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
  const [gender, setGender] = useState("female");
  const [style, setStyle] = useState("any");
  const [age, setAge] = useState("any");
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);

  const params = useMemo(() => {
    const next = new URLSearchParams({ sort, limit: "28" });
    if (query.trim()) next.set("q", query.trim());
    if (activeCategory !== "All") next.set("tags", activeCategory);
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
  }, [activeCategory, age, gender, query, sort, style]);

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
        <CharacterGrid cards={cards} loading={loading} />
      </div>
    </>
  );
}
