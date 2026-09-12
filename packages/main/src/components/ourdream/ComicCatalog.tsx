"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { comicListSchema, type ComicSummary } from "@idream/shared/comics";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { comicButton, comicRequest } from "./comic-client";
import { ComicShell } from "./ComicShell";

export function ComicCatalog({ mine = false }: { mine?: boolean }) {
  return <ComicShell><h1 className="sr-only">{mine ? "Your Comics" : "Comics"}</h1><ComicDiscovery mine={mine} /></ComicShell>;
}

export function ComicDiscovery({ creatorId, mine = false, compact = false }: { creatorId?: string; mine?: boolean; compact?: boolean }) {
  const { accepted } = useAgeGateAccess();
  const [items, setItems] = useState<ComicSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor?: string) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setLoading(true); setError("");
    if (!cursor) { setItems([]); setNextCursor(null); }
    const query = new URLSearchParams({ limit: compact ? "4" : "12" });
    if (mine) query.set("scope", "mine");
    if (creatorId) query.set("creatorId", creatorId);
    if (cursor) query.set("cursor", cursor);
    try {
      const result = await comicRequest(`/api/v1/comics?${query}`, comicListSchema, { signal: next.signal });
      if (next.signal.aborted) return;
      setItems((current) => cursor ? [...current, ...result.items.filter((item) => !current.some((old) => old.id === item.id))] : result.items);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (!next.signal.aborted) setError(cause instanceof Error ? cause.message : "Comics could not load.");
    } finally { if (!next.signal.aborted) setLoading(false); }
  }, [compact, creatorId, mine]);
  useEffect(() => {
    const initialLoad = window.setTimeout(() => { if (accepted) void load(); }, 0);
    const refresh = () => { if (accepted) void load(); };
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(initialLoad); controller.current?.abort(); window.removeEventListener("focus", refresh); };
  }, [accepted, load]);
  return <section aria-label={mine ? "Your Comics" : "Comics"} className="my-8">
    <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div><h2 className={`${compact ? "text-2xl" : "text-4xl"} font-black`}>{mine ? "Your Comics" : "Comics"}</h2>
        <p className="mt-2 max-w-prose text-sm text-neutral-300">{mine ? "Build a story from your Gallery. Arrange chapters, save a draft, then submit it for publication." : "Stories from the community, one page at a time."}</p></div>
      <Link className={comicButton} href={mine ? "/creator-studio/comics/new" : compact ? "/comics" : "/creator-studio/comics"}>{mine ? "Create Comic" : compact ? "Browse Comics" : "Create a Comic"}</Link>
    </header>
    {error && <p className="mb-4 text-sm text-pink-200" role="alert">{error} <button className="ml-2 underline" onClick={() => void load()} type="button">Retry</button></p>}
    {loading && !items.length && <p role="status" className="py-8 text-neutral-300">Loading Comics…</p>}
    {!loading && !error && !items.length && <p className="rounded-xl border border-white/10 px-5 py-8 text-neutral-300">{mine ? "Your first story starts here. Create a Comic and add images from your Gallery." : "No published Comics yet. New stories will appear here."}</p>}
    <ul className={`grid gap-5 ${compact ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-2 xl:grid-cols-3"}`}>
      {items.map((item) => <li key={item.id} className="min-w-0">
        <Link className="group block" href={mine ? `/creator-studio/comics/${encodeURIComponent(item.id)}` : `/comics/${encodeURIComponent(item.id)}`}>
          <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-white/5">{item.coverUrl ? <Image alt="" fill className="object-cover transition-transform group-hover:scale-[1.02] motion-reduce:transition-none" sizes="(max-width:640px) 100vw, 33vw" src={item.coverUrl} unoptimized /> : <span className="flex h-full items-center justify-center text-neutral-300">Add your first page</span>}</div>
          <h3 className="mt-3 truncate text-lg font-bold">{item.title}</h3>
          <p className="mt-1 text-sm text-neutral-300">{item.episodeCount} chapters · {item.pageCount} pages{mine ? ` · ${item.status.replaceAll("_", " ")} · ${item.visibility}` : ` · ${item.creator.displayName}`}</p>
        </Link>
      </li>)}
    </ul>
    {nextCursor && !compact && <button className={`${comicButton} mt-6`} disabled={loading} onClick={() => void load(nextCursor)} type="button">{loading ? "Loading…" : "Load more Comics"}</button>}
  </section>;
}
