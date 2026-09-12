"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { comicDetailSchema, type ComicDetail } from "@idream/shared/comics";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { comicButton, comicRequest } from "./comic-client";
import { ComicShell } from "./ComicShell";
import { parseChatSessionCreateResponse, parsePublicApiError } from "@/lib/public-api-contracts";
import { authHrefForTarget } from "./authRedirect";

export function ComicReader({ id }: { id: string }) {
  const { accepted } = useAgeGateAccess();
  const [comic, setComic] = useState<ComicDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    setComic(null); setError(""); setLoading(true);
    try {
      const result = await comicRequest(`/api/v1/comics/${encodeURIComponent(id)}`, comicDetailSchema, { signal: next.signal });
      if (!next.signal.aborted) setComic(result);
    } catch (cause) { if (!next.signal.aborted) setError(cause instanceof Error ? cause.message : "Comic could not load."); }
    finally { if (!next.signal.aborted) setLoading(false); }
  }, [id]);
  useEffect(() => {
    const initialLoad = window.setTimeout(() => { if (accepted) void load(); }, 0);
    const refresh = () => { if (accepted) void load(); };
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(initialLoad); controller.current?.abort(); window.removeEventListener("focus", refresh); };
  }, [accepted, load]);
  async function startChat(characterId: string) {
    if (chatPending) return;
    setChatPending(true); setChatError("");
    try {
      const response = await fetch("/api/v1/chat/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ characterId }) });
      if (response.status === 401) { window.location.assign(authHrefForTarget("/login", `/comics/${encodeURIComponent(id)}`)); return; }
      const raw: unknown = await response.json();
      if (!response.ok) throw new Error(parsePublicApiError(raw)?.message ?? "Chat could not start. Try again.");
      const result = parseChatSessionCreateResponse(raw);
      window.location.assign(`/chat/${encodeURIComponent(result.session.id)}`);
    } catch (cause) { setChatError(cause instanceof Error ? cause.message : "Chat could not start. Try again."); }
    finally { setChatPending(false); }
  }
  return <ComicShell>
    {loading && <p role="status">Loading Comic…</p>}
    {error && <div role="alert"><p>{error}</p><button className={`${comicButton} mt-4`} onClick={() => void load()} type="button">Reload Comic</button></div>}
    {chatError && <p role="alert" className="mb-4 text-pink-200">{chatError}</p>}
    {comic && <article className="mx-auto max-w-3xl">
      <header className="mb-10"><h1 className="break-words text-4xl font-black md:text-5xl">{comic.title}</h1>
        <p className="mt-4 text-sm text-neutral-300">By <Link className="font-bold text-white underline underline-offset-4" href={`/creators/${encodeURIComponent(comic.creator.id)}`}>{comic.creator.displayName}</Link> · {comic.pageCount} pages</p>
        {comic.description && <p className="mt-5 max-w-prose whitespace-pre-line leading-7 text-neutral-200">{comic.description}</p>}
        {comic.canManage && <div className="mt-5 flex flex-wrap items-center gap-4"><Link className={comicButton} href={`/creator-studio/comics/${encodeURIComponent(id)}`}>Manage Comic</Link><span className="text-sm text-neutral-300">{comic.status.replaceAll("_", " ")} · {comic.visibility}</span></div>}
      </header>
      <nav aria-label="Chapters" className="mb-8 flex flex-wrap gap-3">{comic.episodes.map((episode, index) => <a className={comicButton} href={`#chapter-${episode.id}`} key={episode.id}>{index + 1}. {episode.title}</a>)}</nav>
      {comic.episodes.map((episode, episodeIndex) => <section className="mb-12 scroll-mt-6" id={`chapter-${episode.id}`} key={episode.id}>
        <h2 className="mb-5 text-2xl font-bold">{episodeIndex + 1}. {episode.title}</h2>
        <div className="space-y-7">{episode.pages.map((page, index) => <figure key={page.id}>
          {page.url ? <Image alt={page.caption || `${episode.title}, page ${index + 1}`} className="h-auto w-full rounded-lg" width={1024} height={1536} src={page.url} unoptimized onError={() => { setComic(null); setError("A page is no longer available. Reload to check this Comic."); }} /> : <p className="rounded-lg bg-white/5 p-8 text-neutral-300">This page is unavailable. Remove it in the Comic editor.</p>}
          {page.caption && <figcaption className="mt-3 whitespace-pre-line leading-7 text-neutral-200">{page.caption}</figcaption>}
          {page.remixHref && <Link className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4" href={page.remixHref}>Remix this page</Link>}
          {page.character && <div className="mt-3 flex flex-wrap gap-4 text-sm"><button className="min-h-11 underline underline-offset-4 disabled:opacity-40" disabled={chatPending} onClick={() => void startChat(page.character!.id)} type="button">{chatPending ? "Starting Chat…" : `Chat with ${page.character.name}`}</button><Link className="inline-flex min-h-11 items-center underline underline-offset-4" href={page.character.remixHref}>Create with this Character</Link></div>}
        </figure>)}</div>
      </section>)}
      <Link className={comicButton} href="/comics">More Comics</Link>
    </article>}
  </ComicShell>;
}
