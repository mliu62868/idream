"use client";

import Form from "next/form";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Hash, LoaderCircle, Search, Sparkles } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import type { CharacterCardData, OurdreamRouteTemplate } from "@/types/ourdream";

const MIN_SUGGEST_QUERY_LENGTH = 2;

type SearchTagSuggestion = {
  category?: string | null;
  label: string;
  slug: string;
};

type SearchRouteSuggestion = {
  description: string;
  href: string;
  template: OurdreamRouteTemplate;
  title: string;
};

type SearchSuggestResponse = {
  ok: boolean;
  data?: {
    characters?: CharacterCardData[];
    routes?: SearchRouteSuggestion[];
    tags?: SearchTagSuggestion[];
  };
};

type SearchSuggestion =
  | {
      href: string;
      id: string;
      image: string;
      kind: "character";
      label: string;
      meta: string;
    }
  | {
      href: string;
      id: string;
      kind: "route";
      label: string;
      meta: string;
      template: OurdreamRouteTemplate;
    }
  | {
      href: string;
      id: string;
      kind: "tag";
      label: string;
      meta: string;
    };

type SuggestStatus = "idle" | "loading" | "ready" | "error";

export function AppSearch() {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [characters, setCharacters] = useState<CharacterCardData[]>([]);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState(() => initialSearchQuery());
  const [routes, setRoutes] = useState<SearchRouteSuggestion[]>([]);
  const [status, setStatus] = useState<SuggestStatus>("idle");
  const [tags, setTags] = useState<SearchTagSuggestion[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const trimmedQuery = query.trim();

  const suggestions = useMemo<SearchSuggestion[]>(() => {
    const characterSuggestions = characters.map((character) => ({
      href: `/characters/${encodeURIComponent(character.id)}`,
      id: `character:${character.id}`,
      image: character.image,
      kind: "character" as const,
      label: character.title,
      meta: `${character.age} · ${character.creator}`,
    }));
    const tagSuggestions = tags.map((tag) => ({
      href: `/?tags=${encodeURIComponent(tag.slug)}`,
      id: `tag:${tag.slug}`,
      kind: "tag" as const,
      label: tag.label,
      meta: tag.category ? `Tag · ${tag.category}` : "Tag",
    }));
    const routeSuggestions = routes.map((route) => ({
      href: route.href,
      id: `route:${route.href}`,
      kind: "route" as const,
      label: route.title,
      meta: routeSuggestionMeta(route),
      template: route.template,
    }));
    return [...characterSuggestions, ...tagSuggestions, ...routeSuggestions].slice(0, 8);
  }, [characters, routes, tags]);

  const panelOpen =
    focused &&
    trimmedQuery.length >= MIN_SUGGEST_QUERY_LENGTH &&
    (status === "loading" || status === "ready" || status === "error");
  const activeSuggestion = suggestions[activeIndex];
  const searchStatusMessage =
    panelOpen && status === "loading"
      ? "Searching..."
      : panelOpen && status === "error"
        ? "Search suggestions unavailable"
        : panelOpen && status === "ready" && suggestions.length === 0
          ? "No suggestions found"
          : "";

  useEffect(() => {
    const syncFromHistory = () => {
      setQuery(initialSearchQuery());
      setActiveIndex(-1);
    };

    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  useEffect(() => {
    if (!focused || trimmedQuery.length < MIN_SUGGEST_QUERY_LENGTH) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const response = await fetch(
          `/api/v1/search/suggest?q=${encodeURIComponent(trimmedQuery)}`,
          {
            headers: { accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          setCharacters([]);
          setRoutes([]);
          setTags([]);
          setStatus(response.status === 403 ? "idle" : "error");
          return;
        }

        const payload = (await response.json()) as SearchSuggestResponse;
        setCharacters(payload.data?.characters ?? []);
        setRoutes(payload.data?.routes ?? []);
        setTags(payload.data?.tags ?? []);
        setStatus("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCharacters([]);
        setRoutes([]);
        setTags([]);
        setStatus("error");
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [focused, trimmedQuery]);

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) return;
    setFocused(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setFocused(false);
      setActiveIndex(-1);
      return;
    }

    if (!panelOpen || suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === "Enter" && activeSuggestion) {
      event.preventDefault();
      setFocused(false);
      router.push(activeSuggestion.href);
    }
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setActiveIndex(-1);
    if (value.trim().length < MIN_SUGGEST_QUERY_LENGTH) {
      setStatus("idle");
      setCharacters([]);
      setRoutes([]);
      setTags([]);
    }
  }

  return (
    <div
      className="relative min-w-0 flex-1 md:max-w-[340px]"
      onBlur={handleBlur}
      onFocus={() => setFocused(true)}
      ref={rootRef}
    >
      <Form
        action="/"
        className="flex w-full min-w-0 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 py-2 text-[12px] font-medium leading-4 text-[rgb(170,170,170)]"
        onSubmit={() => setFocused(false)}
      >
        <button
          aria-label="Search"
          className="grid h-4 w-4 shrink-0 place-items-center text-[rgb(170,170,170)] transition hover:text-white"
          type="submit"
        >
          <Search aria-hidden="true" className="h-4 w-4" />
        </button>
        <input
          aria-activedescendant={
            activeSuggestion ? optionId(activeIndex) : undefined
          }
          aria-autocomplete="list"
          aria-controls="app-search-suggestions"
          aria-describedby={searchStatusMessage ? "app-search-status" : undefined}
          aria-label="Search characters, guides, and generators"
          autoComplete="off"
          className="min-w-0 flex-1 truncate bg-transparent text-white outline-none placeholder:text-[rgb(170,170,170)]"
          name="q"
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search characters, guides, and generators"
          suppressHydrationWarning
          type="search"
          value={query}
        />
      </Form>

      {panelOpen ? (
        <div
          aria-label="Search suggestions"
          aria-busy={status === "loading" ? "true" : undefined}
          className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-1 shadow-[0_16px_40px_rgba(0,0,0,0.38)]"
          id="app-search-suggestions"
          role="listbox"
        >
          {status === "loading" ? (
            <div
              aria-live="polite"
              className="flex h-11 items-center gap-2 px-3 text-[12px] font-bold text-[rgb(170,170,170)]"
              data-testid="app-search-status"
              id="app-search-status"
              role="status"
            >
              <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              Searching...
            </div>
          ) : null}

          {status === "error" ? (
            <div
              aria-live="polite"
              className="px-3 py-3 text-[12px] font-bold text-[rgb(170,170,170)]"
              data-testid="app-search-status"
              id="app-search-status"
              role="status"
            >
              Search suggestions unavailable
            </div>
          ) : null}

          {status === "ready" && suggestions.length === 0 ? (
            <div
              aria-live="polite"
              className="px-3 py-3 text-[12px] font-bold text-[rgb(170,170,170)]"
              data-testid="app-search-status"
              id="app-search-status"
              role="status"
            >
              No suggestions found
            </div>
          ) : null}

          {status === "ready"
            ? suggestions.map((suggestion, index) => (
                <Link
                  aria-label={`Open ${suggestion.label}`}
                  aria-selected={activeIndex === index}
                  className={cn(
                    "flex min-h-12 items-center gap-3 rounded-[9px] px-2 py-2 text-left transition-colors hover:bg-[rgb(36,36,36)]",
                    activeIndex === index && "bg-[rgb(46,46,46)]",
                  )}
                  href={suggestion.href}
                  id={optionId(index)}
                  key={suggestion.id}
                  onClick={() => setFocused(false)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                >
                  {suggestion.kind === "character" ? (
                    <Image
                      alt=""
                      className="h-10 w-10 shrink-0 rounded-[8px] object-cover object-top"
                      height={40}
                      sizes="40px"
                      src={suggestion.image}
                      unoptimized={isPrivateMediaUrl(suggestion.image)}
                      width={40}
                    />
                  ) : (
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[8px] bg-[rgb(36,36,36)] text-[rgb(253,95,194)]">
                      {suggestion.kind === "tag" ? (
                        <Hash aria-hidden="true" className="h-4 w-4" />
                      ) : suggestion.template === "generator" ? (
                        <Sparkles aria-hidden="true" className="h-4 w-4" />
                      ) : (
                        <FileText aria-hidden="true" className="h-4 w-4" />
                      )}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-black leading-4 text-white">
                      {suggestion.label}
                    </span>
                    <span className="mt-1 block truncate text-[11px] font-bold leading-3 text-[rgb(170,170,170)]">
                      {suggestion.meta}
                    </span>
                  </span>
                </Link>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

function optionId(index: number) {
  return `app-search-suggestion-${index}`;
}

function initialSearchQuery() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("q") ?? "";
}

function routeSuggestionMeta(route: SearchRouteSuggestion) {
  if (route.template === "generator") return "Generator";
  if (route.template === "comparison") return "Comparison";
  if (route.template === "library") return "Resource";
  if (route.href.startsWith("/guides/")) return "Guide";
  if (route.href.startsWith("/videos/")) return "Video guide";
  return "Page";
}

function isPrivateMediaUrl(url: string) {
  return url.startsWith("/api/v1/media/") || url.startsWith("/user-content/");
}
