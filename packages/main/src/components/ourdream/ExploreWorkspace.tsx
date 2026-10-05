"use client";

import Link from "next/link";
import { comicListSchema } from "@idream/shared/comics";
import { packListSchema } from "@idream/shared/packs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useViewerGate, type ViewerGate } from "@/hooks/useViewerGate";
import { isAbortError } from "@/lib/viewer-resource-client";
import {
  CHARACTER_STYLE_FILTER_VALUES,
  GENDER_FILTER_VALUES,
} from "@/lib/character-taxonomy";
import { canStartAgeGatedLoad } from "@/lib/age-gate";
import {
  parseCharacterListResponse,
  parseTagListResponse,
} from "@/lib/public-api-contracts";
import type { CharacterCardData } from "@/types/ourdream";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { CharacterGrid } from "./CharacterGrid";
import { TopControls } from "./TopControls";
import { comicPayload } from "./comic-client";
import { packPayload } from "./pack-client";
import { VIEWER_AUTH_CHANGE_STORAGE_KEY } from "./viewer-auth";

const DEFAULT_LIMIT = 28;

// Only the current/previous Explore entry is remembered. Cards and cursors are
// always fetched again; the actor key stays in memory, outside browser history.
const MAX_RESTORE_PAGES = 60;
type ExploreCheckpoint = { token: number; scope: string; authNonce: string | null; filterKey: string; pages: number; scrollY: number };
let previousExplore: ExploreCheckpoint | null = null;
let checkpointSequence = 0;

function exploreFilterKey(search: string) {
  const params = new URLSearchParams(search);
  params.sort();
  return params.toString();
}

function atExploreFilter(filterKey: string) {
  return (window.location.pathname === "/" || window.location.pathname === "/explore") && exploreFilterKey(window.location.search) === filterKey;
}

function readAuthNonce() {
  try { return { value: window.localStorage.getItem(VIEWER_AUTH_CHANGE_STORAGE_KEY) }; }
  catch { return null; }
}

function readExploreCheckpoint(): ExploreCheckpoint | null {
  const checkpoint = previousExplore;
  const meta = window.history.state?.__idreamExplore;
  const auth = readAuthNonce();
  if (!checkpoint || !meta || !auth || auth.value !== checkpoint.authNonce || !atExploreFilter(checkpoint.filterKey) ||
    meta.token !== checkpoint.token || meta.filterKey !== checkpoint.filterKey || meta.pages !== checkpoint.pages || meta.scrollY !== checkpoint.scrollY ||
    !Number.isInteger(meta.pages) || meta.pages < 1 || meta.pages > MAX_RESTORE_PAGES || !Number.isFinite(meta.scrollY) || meta.scrollY < 0) {
    previousExplore = null;
    return null;
  }
  return checkpoint;
}

export function ExploreWorkspace() {
  const viewer = useViewerGate({ require: "any" });
  const revalidate = viewer.revalidate;
  const [entry, setEntry] = useState<{ resume: ExploreCheckpoint | null; error: string | null } | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const retryEntry = useCallback(() => { setEntry(null); setCheckAttempt(attempt => attempt + 1); }, []);
  useEffect(() => viewer.gate.onOwnerChange?.(() => { previousExplore = null; }), [viewer.gate]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const resume = readExploreCheckpoint();
      if (!resume) { setEntry({ resume: null, error: null }); return; }
      // A route gap can recreate the identity object. Confirm the owner key and
      // unchanged auth nonce, rather than trusting a cached identity or cards.
      void revalidate().then(identity => {
        if (cancelled) return;
        if (!identity) { setEntry({ resume: null, error: "Could not restore your Explore place. Check your account and retry." }); return; }
        const scope = identity.kind === "user" ? identity.scope : "anonymous";
        const auth = readAuthNonce();
        const admitted = scope === resume.scope && auth && auth.value === resume.authNonce && atExploreFilter(resume.filterKey) && previousExplore?.token === resume.token;
        if (!admitted) previousExplore = null;
        setEntry({ resume: admitted ? resume : null, error: null });
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [checkAttempt, revalidate]);
  if (!entry) return <p className="p-6 text-sm text-neutral-300" role="status">Loading characters...</p>;
  if (entry.error) return <p className="p-6 text-sm text-pink-200" role="alert">{entry.error} <button className="ml-2 underline" onClick={retryEntry} type="button">Retry</button></p>;
  // Following results and category visibility are personalized. Route filters
  // survive in the URL; the previous actor's cards, tags and cursor do not.
  return <ExploreViewerWorkspace key={viewer.scope ?? (viewer.identity ? "anonymous" : "unconfirmed")} viewer={viewer} resume={entry.resume} onRestoreRetry={retryEntry} />;
}

function ExploreViewerWorkspace({ viewer, resume, onRestoreRetry }: { viewer: ViewerGate; resume: ExploreCheckpoint | null; onRestoreRetry: () => void }) {
  const { accepted: ageGateAccepted } = useAgeGateAccess();
  const gatedFetch = viewer.fetch;
  const [cards, setCards] = useState<CharacterCardData[]>([]);
  const [activeCategory, setActiveCategory] = useState("");
  const [availableCategories, setAvailableCategories] = useState<readonly { slug: string; label: string }[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("for-you");
  const [period, setPeriod] = useState("month");
  const [gender, setGender] = useState("female");
  const [style, setStyle] = useState("any");
  const [age, setAge] = useState("any");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagError, setTagError] = useState(false);
  const [publicTypes, setPublicTypes] = useState({ comics: false, packs: false });
  const [initialized, setInitialized] = useState(false);
  // Debounced mirror of `query`: drives requests/URL so typing doesn't fire one
  // fetch per keystroke. `query` stays the immediate value bound to the input.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const requestSerial = useRef(0);
  const mountedRef = useRef(false);
  const loadedPagesRef = useRef(0);
  const resumeRef = useRef(resume?.scope === (viewer.scope ?? (viewer.identity ? "anonymous" : "unconfirmed")) ? resume : null);
  const restoringRef = useRef(false);
  const scrollIntentRef = useRef(0);
  const [scrollRestore, setScrollRestore] = useState<{ serial: number; y: number; authNonce: string | null; intent: number } | null>(null);
  useLayoutEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; requestSerial.current += 1; }; }, []);

  const categoryOptions = useMemo(() => {
    // Labels can change without changing the dictionary slug. Disambiguate
    // repeated labels (including "All") while retaining the query identity.
    const options = [{ slug: "", label: "All" }, ...availableCategories];
    // A dictionary outage must not discard a deep link's selected filter.
    if (activeCategory && !options.some(category => category.slug === activeCategory)) {
      options.push({ slug: activeCategory, label: activeCategory });
    }
    const counts = new Map<string, number>();
    for (const { label } of options) counts.set(label, (counts.get(label) ?? 0) + 1);
    const usedLabels = new Set<string>();
    return options.map(category => {
      let label = category.slug && counts.get(category.label)! > 1
        ? `${category.label} (${category.slug})` : category.label;
      // TopControls returns a display string. Generated suffixes can themselves
      // be legal dictionary labels, so make the entire set unambiguous.
      while (usedLabels.has(label)) label += ` (${category.slug})`;
      usedLabels.add(label);
      return { slug: category.slug, label };
    });
  }, [activeCategory, availableCategories]);

  const params = useMemo(() => {
    const next = new URLSearchParams({ sort, limit: String(limit) });
    if (sort === "popular") next.set("period", period);
    if (debouncedQuery.trim()) next.set("q", debouncedQuery.trim());
    if (activeCategory) next.set("tags", activeCategory);
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
  }, [activeCategory, age, debouncedQuery, gender, limit, period, sort, style]);

  const exploreSearch = useMemo(() => {
    const urlParams = new URLSearchParams();
    if (debouncedQuery.trim()) urlParams.set("q", debouncedQuery.trim());
    if (sort !== "for-you") urlParams.set("sort", sort);
    if (sort === "popular" && period !== "month") urlParams.set("period", period);
    if (gender !== "female") urlParams.set("gender", gender);
    if (style !== "any") urlParams.set("style", style);
    if (activeCategory) urlParams.set("tags", activeCategory);
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

    return urlParams.toString();
  }, [activeCategory, age, debouncedQuery, gender, limit, period, sort, style]);
  const filterKey = exploreFilterKey(exploreSearch);
  const rememberPosition = useCallback((position = window.scrollY) => {
    const auth = readAuthNonce();
    if (!mountedRef.current || resumeRef.current || !viewer.identity || !auth || !atExploreFilter(filterKey) || loadedPagesRef.current < 1) return;
    if (loadedPagesRef.current > MAX_RESTORE_PAGES) { previousExplore = null; return; }
    const checkpoint: ExploreCheckpoint = { token: ++checkpointSequence, scope: viewer.scope ?? "anonymous", authNonce: auth.value, filterKey, pages: loadedPagesRef.current, scrollY: Number.isFinite(position) ? Math.max(0, position) : 0 };
    previousExplore = checkpoint;
    // Metadata only, on this exact entry. Never write during route cleanup,
    // when Next may already have moved history to a character detail.
    window.history.replaceState({ ...window.history.state, __idreamExplore: { token: checkpoint.token, filterKey, pages: checkpoint.pages, scrollY: checkpoint.scrollY } }, "", window.location.href);
  }, [filterKey, viewer.identity, viewer.scope]);
  useEffect(() => {
    const onScroll = () => rememberPosition();
    const onScrollIntent = () => { scrollIntentRef.current += 1; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]"))) onScrollIntent();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    // Browser Back may scroll while the shorter first page is rendered. Only
    // explicit user input overrides the position restored after all pages.
    window.addEventListener("wheel", onScrollIntent, { passive: true });
    window.addEventListener("touchstart", onScrollIntent, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onScrollIntent);
      window.removeEventListener("touchstart", onScrollIntent);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rememberPosition]);
  useEffect(() => {
    if (!scrollRestore) return;
    const frame = window.requestAnimationFrame(() => {
      const auth = readAuthNonce();
      if (mountedRef.current && scrollRestore.serial === requestSerial.current && atExploreFilter(filterKey) && auth && auth.value === scrollRestore.authNonce) {
        if (scrollIntentRef.current === scrollRestore.intent) window.scrollTo({ top: scrollRestore.y, left: 0, behavior: "instant" });
        else rememberPosition();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filterKey, rememberPosition, scrollRestore]);

  const loadCharacters = useCallback(
    async (cursor?: string) => {
      if (!ageGateAccepted || !viewer.identity) return;
      const serial = ++requestSerial.current;
      const scrollIntent = scrollIntentRef.current;
      const plan = !cursor && resumeRef.current?.filterKey === filterKey ? resumeRef.current : null;
      if (!cursor) {
        loadedPagesRef.current = 0;
        if (!plan) resumeRef.current = null;
      }
      restoringRef.current = Boolean(plan);
      setLoadingMore(Boolean(cursor));
      if (!cursor) setLoading(true);
      setError(null);
      setScrollRestore(null);
      const current = () => mountedRef.current && serial === requestSerial.current && atExploreFilter(filterKey);
      try {
        let pageCursor = cursor;
        const seen = new Set<string>();
        do {
          const requestParams = new URLSearchParams(params);
          if (pageCursor) requestParams.set("cursor", pageCursor);
          const response = await gatedFetch(`/api/v1/characters?${requestParams.toString()}`, { cache: "no-store" });
          if (!response.ok) throw new Error("Characters unavailable");
          const payload = parseCharacterListResponse(await response.json());
          if (!current()) return;
          if (plan && readAuthNonce()?.value !== plan.authNonce) { previousExplore = null; return; }
          const append = Boolean(cursor) || loadedPagesRef.current > 0;
          setCards(items => append ? [...items, ...payload.items] : payload.items);
          loadedPagesRef.current += 1;
          setNextCursor(payload.nextCursor);
          if (!plan) { rememberPosition(); break; }
          if (loadedPagesRef.current >= plan.pages) {
            resumeRef.current = null;
            rememberPosition(scrollIntentRef.current === scrollIntent ? plan.scrollY : window.scrollY);
            if (scrollIntentRef.current === scrollIntent) setScrollRestore({ serial, y: plan.scrollY, authNonce: plan.authNonce, intent: scrollIntent });
            break;
          }
          if (!payload.nextCursor || seen.has(payload.nextCursor)) {
            setError("The catalog changed. Could not restore your previous Explore place. Retry to check again.");
            break;
          }
          seen.add(payload.nextCursor);
          pageCursor = payload.nextCursor;
        } while (current());
      } catch (error) {
        if (isAbortError(error) || !current()) return;
        if (!cursor && !plan) { setCards([]); setNextCursor(null); }
        setError(plan ? "Could not restore your Explore place. Retry to reload its pages." : cursor ? "Could not load more characters." : "Could not load characters.");
      } finally {
        if (!current()) return;
        restoringRef.current = false;
        if (cursor) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [ageGateAccepted, filterKey, gatedFetch, params, rememberPosition, viewer.identity],
  );

  useEffect(() => {
    if (!canStartAgeGatedLoad(ageGateAccepted, initialized)) return;
    const timer = window.setTimeout(() => {
      // Same-owner focus can finish during a restore; it must not start a
      // competing first-page read or append the same page twice.
      if (restoringRef.current && resumeRef.current?.filterKey === filterKey) return;
      void loadCharacters();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ageGateAccepted, filterKey, initialized, loadCharacters, viewer.revalidation]);

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
      setPeriod(initial.period);
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
    if (!ageGateAccepted || !viewer.identity) return;
    let cancelled = false;

    async function loadTags() {
      try {
        const response = await gatedFetch("/api/v1/tags", { cache: "no-store" });
        if (!response.ok) throw new Error("Tags unavailable");
        const payload = parseTagListResponse(await response.json());
        if (cancelled) return;
        setTagError(false);
        // The dictionary owns both the display label and immutable query slug.
        setAvailableCategories(payload.items
          .filter(tag => !tag.isMutedByDefault && !tag.isMutedByUser && tag.publicCharacterCount > 0)
          .map(({ slug, label }) => ({ slug, label })));
      } catch (error) {
        if (isAbortError(error)) return;
        if (!cancelled) {
          setAvailableCategories([]);
          setTagError(true);
        }
      }
    }

    void loadTags();
    return () => {
      cancelled = true;
    };
  }, [ageGateAccepted, gatedFetch, viewer.identity, viewer.revalidation]);



  useEffect(() => {
    if (!initialized) return;
    if (window.location.pathname !== "/" && window.location.pathname !== "/explore") return;
    const nextUrl = exploreSearch ? `${window.location.pathname}?${exploreSearch}` : window.location.pathname;
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      const state = { ...window.history.state };
      if (state.__idreamExplore?.filterKey !== filterKey) {
        delete state.__idreamExplore;
        previousExplore = null;
      }
      // URL changes use Next's public native-history path. Passing its internal
      // flags bypasses canonical URL updates; Next copies its tree/flags back.
      delete state.__NA;
      delete state._N;
      window.history.replaceState(state, "", nextUrl);
    }
  }, [exploreSearch, filterKey, initialized]);

  useEffect(() => {
    if (!ageGateAccepted || !viewer.identity) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPublicTypes({ comics: false, packs: false });
      // These links discover published catalogs, independently of character
      // tag filters. Private group conversations have no public authority here.
      for (const catalog of [
        { key: "comics" as const, path: "/api/v1/comics", parse: comicPayload(comicListSchema) },
        { key: "packs" as const, path: "/api/v1/packs", parse: packPayload(packListSchema) },
      ]) {
        void (async () => {
          try {
            let cursor: string | null = null;
            const seen = new Set<string>();
            do {
              if (cancelled) return;
              const query = new URLSearchParams({ scope: "public", limit: "1" });
              if (cursor) query.set("cursor", cursor);
              const response = await gatedFetch(`${catalog.path}?${query}`, { cache: "no-store", signal: controller.signal });
              if (!response.ok) return;
              const list = catalog.parse(await response.json());
              if (cancelled) return;
              if (list.items.some(item => item.status === "published" && item.visibility === "public" &&
                ("pageCount" in item ? item.pageCount > 0 && item.episodeCount > 0 : item.itemCount > 0))) {
                setPublicTypes(current => ({ ...current, [catalog.key]: true }));
                return;
              }
              // Comic authority may discard an invalid row after pagination.
              // An empty page does not prove the public catalog is empty.
              cursor = list.nextCursor;
              if (cursor && seen.has(cursor)) return;
              if (cursor) seen.add(cursor);
            } while (cursor);
          } catch {
            // Unconfirmed availability does not create an empty or broken link.
          }
        })();
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); controller.abort(); };
  }, [ageGateAccepted, gatedFetch, viewer.identity, viewer.revalidation]);

  const emptyState =
    sort === "following"
      ? {
          description:
            "Follow creators from Community to see their public characters here.",
          title: "No followed characters yet",
        }
      : {
          description:
            "Try another search term, clear a category, or switch the gender, style, and age filters.",
          title: "No characters found",
        };

  return (
    <>
      <TopControls
        activeCategory={categoryOptions.find(category => category.slug === activeCategory)!.label}
        age={age}
        categories={categoryOptions.map(category => category.label)}
        gender={gender}
        onCategoryChange={label => {
          const category = categoryOptions.find(category => category.label === label);
          if (category) setActiveCategory(category.slug);
        }}
        onAgeChange={setAge}
        onGenderChange={setGender}
        onQueryChange={setQuery}
        onPeriodChange={setPeriod}
        onSortChange={setSort}
        onStyleChange={setStyle}
        query={query}
        period={period}
        sort={sort}
        style={style}
      />
      {initialized && <nav aria-label="Explore content types" className="mx-2 mb-2 flex gap-2 overflow-x-auto md:mx-[60px] md:mt-3">
        <Link aria-current="page" className="inline-flex min-h-9 shrink-0 items-center rounded-full bg-white px-4 text-xs font-bold text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" href={exploreSearch ? `/?${exploreSearch}` : "/"}>All</Link>
        {publicTypes.comics && <Link className="inline-flex min-h-9 shrink-0 items-center rounded-full border border-white/20 px-4 text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" href="/comics">Comics</Link>}
        {publicTypes.packs && <Link className="inline-flex min-h-9 shrink-0 items-center rounded-full border border-white/20 px-4 text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" href="/packs">Packs</Link>}
      </nav>}
      {tagError ? (
        <p
          aria-live="polite"
          className="mx-4 mt-3 rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] px-4 py-3 text-[12px] font-semibold text-[rgb(170,170,170)] md:mx-[60px]"
          data-testid="explore-tags-status"
          role="status"
        >
          Categories are temporarily unavailable. Your current filters are still applied.
        </p>
      ) : null}
      <div className="pt-2 md:pt-6">
        <CharacterGrid
          cards={cards}
          emptyDescription={emptyState.description}
          emptyTitle={emptyState.title}
          error={error || viewer.error}
          hasMore={Boolean(nextCursor)}
          loading={!initialized || (!viewer.identity && !viewer.error) || loading}
          loadingMore={loadingMore}
          onLoadMore={() => {
            if (nextCursor) void loadCharacters(nextCursor);
          }}
          onRetry={() => { if (resumeRef.current) onRestoreRetry(); else if (viewer.error) void viewer.revalidate(); else void loadCharacters(); }}
        />
      </div>
    </>
  );
}

function parseExploreSearchParams(search: string) {
  const params = new URLSearchParams(search);
  return {
    activeCategory: params.get("tags")?.trim() ?? "",
    age: ageFromParams(params),
    gender: enumParam(params.get("gender"), GENDER_FILTER_VALUES, "female"),
    limit: clampLimit(params.get("limit")),
    query: params.get("q") ?? "",
    period: enumParam(params.get("period"), ["week", "month", "all"], "month"),
    sort: enumParam(params.get("sort"), ["for-you", "popular", "newest", "following"], "for-you"),
    style: enumParam(params.get("style"), CHARACTER_STYLE_FILTER_VALUES, "any"),
  };
}

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
