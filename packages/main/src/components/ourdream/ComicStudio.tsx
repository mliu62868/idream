"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { comicDetailSchema, comicManifestSchema, type ComicDetail, type ComicManifest } from "@idream/shared/comics";
import { parsePublicApiError, parseWorkspaceMediaResponse, type RuntimeWorkspaceMediaItem } from "@/lib/public-api-contracts";
import { useViewerGate } from "@/hooks/useViewerGate";
import { isAbortError, loadViewerResource } from "@/lib/viewer-resource-client";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { comicButton, comicInput, comicPayload } from "./comic-client";
import { ComicShell } from "./ComicShell";
import { authHrefForTarget } from "./authRedirect";

const parseComic = comicPayload(comicDetailSchema);

const emptyManifest: ComicManifest = { title: "", description: "", visibility: "private", allowRemix: false, episodes: [{ title: "Chapter 1", pages: [] }] };
function manifestFromComic(comic: ComicDetail): ComicManifest {
  return { title: comic.title, description: comic.description, visibility: comic.visibility, allowRemix: comic.allowRemix,
    episodes: comic.episodes.map((episode) => ({ title: episode.title, pages: episode.pages.map((page) => ({ mediaAssetId: page.mediaAssetId ?? "", caption: page.caption })) })) };
}
function move<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]; const [item] = next.splice(from, 1); if (item !== undefined) next.splice(to, 0, item); return next;
}

export function ComicStudio({ id }: { id?: string }) {
  const { accepted } = useAgeGateAccess();
  const [comic, setComic] = useState<ComicDetail | null>(null);
  const [manifest, setManifest] = useState<ComicManifest>(emptyManifest);
  const [gallery, setGallery] = useState<RuntimeWorkspaceMediaItem[]>([]);
  const [galleryCursor, setGalleryCursor] = useState<string | null>(null);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState("");
  const [loading, setLoading] = useState(Boolean(id));
  const [writing, setWriting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [chapter, setChapter] = useState(0);
  const [viewerChanged, setViewerChanged] = useState(false);
  // SPEC: the editor is locked, not reloaded, when the signed-in account moves.
  // INTENT: every other gated surface answers an account change by re-reading.
  // This one holds an unsaved draft, so re-reading would either discard the
  // author's work or, worse, leave it on screen for whoever is signed in now to
  // submit. The gate supplies the one fact — who the server says is looking —
  // and this surface keeps its own, stricter answer to it.
  const viewer = useViewerGate();
  const authorId = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const editable = (!id || Boolean(comic?.canManage)) && (!comic || ["draft", "withdrawn"].includes(comic.status));
  const disabled = loading || writing || viewerChanged || !editable;
  // beforeunload reads the ref, not a render snapshot: creating a draft navigates
  // synchronously after saving, before React can re-register a clean listener.
  const markDirty = useCallback((value: boolean) => { dirtyRef.current = value; setDirty(value); }, []);

  const gatedFetch = viewer.fetch;
  const load = useCallback(async () => {
    if (!id) return;
    setComic(null); setManifest(emptyManifest); setLoading(true); setError(""); markDirty(false);
    const outcome = await loadViewerResource({
      path: `/api/v1/comics/${encodeURIComponent(id)}`,
      parse: parseComic,
      fallbackError: "Comic could not load.",
      init: { cache: "no-store" },
    }, gatedFetch);
    if (outcome.kind === "discarded") return;
    setLoading(false);
    if (outcome.kind === "failed") { setError(outcome.error); return; }
    if (!outcome.data.canManage) { setError("Only this Comic’s creator can edit it."); return; }
    authorId.current = outcome.data.creator.id;
    setComic(outcome.data); setManifest(manifestFromComic(outcome.data));
  }, [gatedFetch, id, markDirty]);

  const loadGallery = useCallback(async (cursor?: string) => {
    setGalleryLoading(true); setGalleryError("");
    const query = new URLSearchParams({ type: "image", limit: "24" });
    if (cursor) query.set("cursor", cursor);
    const outcome = await loadViewerResource({
      path: `/api/v1/media?${query}`,
      parse: parseWorkspaceMediaResponse,
      fallbackError: "Gallery could not load.",
      init: { cache: "no-store" },
    }, async (input, init) => {
      const response = await gatedFetch(input, init);
      // INVARIANT: 401 is a navigation, not an error banner — the editor cannot
      // do anything useful for a signed-out viewer, and the sign-in target has
      // to carry this draft's own return path.
      if (response.status === 401) {
        window.location.assign(authHrefForTarget("/login", id ? `/creator-studio/comics/${encodeURIComponent(id)}` : "/creator-studio/comics/new"));
      }
      return response;
    });
    if (outcome.kind === "discarded") return;
    setGalleryLoading(false);
    if (outcome.kind === "failed") { setGalleryError(outcome.error); return; }
    setGallery((current) => cursor ? [...current, ...outcome.data.items.filter((item) => !current.some((old) => old.id === item.id))] : outcome.data.items);
    setGalleryCursor(outcome.data.nextCursor ?? null);
  }, [gatedFetch, id]);

  // SPEC: the reads run once the server has named the viewer, and not again on
  // re-validation.
  // INTENT: the read-only surfaces depend on `viewer.revalidation` so a focus
  // re-reads them. An editor must not: re-reading would overwrite the ordering
  // and captions the author has typed but not saved. `confirmed` flips once,
  // when the gate first has an identity to issue tickets against — and stays
  // stable across a focus that confirms the same account, because the gate
  // hands back the identity object it already had.
  // The reads start on the next task: both set loading state on their way out,
  // and setting state synchronously from an effect cascades renders.
  const confirmed = viewer.identity !== null;
  useEffect(() => {
    if (!accepted || !confirmed) return;
    const start = window.setTimeout(() => { void load(); void loadGallery(); }, 0);
    return () => window.clearTimeout(start);
  }, [accepted, confirmed, load, loadGallery]);

  const identity = viewer.identity;
  const seenIdentity = useRef(identity);
  useEffect(() => {
    const previous = seenIdentity.current;
    seenIdentity.current = identity;
    // The first confirmation is not a change, and `load` has not named an author
    // yet on the very first pass.
    if (identity === null || previous === null || previous === identity) return;
    if (identity.kind === "user" && identity.userId === authorId.current) return;
    // INVARIANT: a cookie change must not expose or submit the previous author's
    // local draft. The gate has already aborted this surface's in-flight reads
    // and bumped its generation, so what remains is dropping what is on screen.
    setComic(null); setManifest(emptyManifest); setGallery([]); markDirty(false); setViewerChanged(true);
    setError("The signed-in account changed. Reload the editor for your current account.");
  }, [identity, markDirty]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  function edit(update: (current: ComicManifest) => ComicManifest) { setManifest(update); markDirty(true); setMessage(""); }
  function editEpisode(index: number, update: (episode: ComicManifest["episodes"][number]) => ComicManifest["episodes"][number]) {
    edit((current) => ({ ...current, episodes: current.episodes.map((episode, ordinal) => ordinal === index ? update(episode) : episode) }));
  }
  async function write(action: "save" | "submit" | "withdraw") {
    if (writing) return;
    setError(""); setMessage("");
    if (action === "save") {
      const result = comicManifestSchema.safeParse(manifest);
      if (!result.success) { setError(result.error.issues[0]?.message ?? "Check your Comic details."); return; }
    }
    if (action !== "save" && !comic) return;
    setWriting(true);
    try {
      const base = `/api/v1/comics${id ? `/${encodeURIComponent(id)}` : ""}`;
      // INVARIANT: the gate re-checks the owner after the reply lands, so a save
      // that was in the air while the account changed throws here instead of
      // painting the previous author's saved draft for whoever is signed in now.
      const response = await gatedFetch(action === "save" ? base : `${base}/${action}`, {
        method: action === "save" && id ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "save" ? id ? { version: comic!.version, manifest } : manifest : { version: comic!.version }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) throw new Error(parsePublicApiError(raw)?.message ?? "Could not save. Try again.");
      const result = parseComic(raw);
      markDirty(false); setComic(result); setManifest(manifestFromComic(result));
      setWriting(false);
      if (!id) { window.location.assign(`/creator-studio/comics/${encodeURIComponent(result.id)}`); return; }
      setMessage(action === "save" ? "Draft saved." : action === "submit" ? "Submitted for review. This version stays locked until a decision or withdrawal." : "Comic withdrawn. Readers can no longer open it; you can edit the draft now.");
    } catch (cause) {
      if (isAbortError(cause)) return;
      setWriting(false);
      setError(cause instanceof Error ? cause.message : "Could not save. Try again.");
    }
  }
  const previews = new Map(gallery.map((item) => [item.id, item.thumbnailUrl || item.url]));
  for (const episode of comic?.episodes ?? []) for (const page of episode.pages) if (page.mediaAssetId && page.url) previews.set(page.mediaAssetId, page.url);
  const pageCount = manifest.episodes.reduce((total, episode) => total + episode.pages.length, 0);

  // INTENT: there is no "Checking your account…" screen any more. Re-confirming
  // the viewer used to replace the whole editor on every focus; the gate does it
  // in the background and only this surface's own verdict — the account actually
  // moved — still takes over the page.
  if (viewerChanged) return <ComicShell><p role="alert">{error}</p><button className={`${comicButton} mt-5`} onClick={() => window.location.reload()} type="button">Reload editor</button></ComicShell>;

  return <ComicShell><div className="mx-auto max-w-6xl">
    <header className="mb-8 flex flex-wrap items-start justify-between gap-5"><div>
      <h1 className="text-4xl font-black">{id ? "Edit Comic" : "Create a Comic"}</h1>
      <p className="mt-3 max-w-prose text-sm leading-6 text-neutral-300">Arrange your own Gallery images into a story. Public Comics appear in discovery after review; unlisted Comics can be opened only by link.</p>
    </div>{comic && <Link className={comicButton} href={`/comics/${encodeURIComponent(comic.id)}`}>Preview Comic</Link>}</header>
    {loading && <p role="status">Loading draft…</p>}
    {error && <p className="mb-5 text-pink-200" role="alert">{error} {id && <button className="ml-2 underline" onClick={() => void load()} type="button">Reload saved draft</button>}</p>}
    {message && <p className="mb-5 text-emerald-200" role="status">{message}</p>}
    {comic && <div className="mb-6 rounded-xl border border-white/15 p-4"><p className="font-bold">{comic.status.replaceAll("_", " ")} · Version {comic.version} · {comic.visibility}</p>
      {comic.reviewNote && <p className="mt-2 text-sm text-neutral-300">Review note: {comic.reviewNote}</p>}
      {["pending_review", "published"].includes(comic.status) && <div className="mt-3 flex flex-wrap items-center gap-4"><button className={comicButton} disabled={writing} onClick={() => void write("withdraw")} type="button">Withdraw Comic</button><p className="text-sm text-neutral-300">Withdraw before editing. Public access ends immediately.</p></div>}
    </div>}
    <fieldset disabled={disabled} className="min-w-0 disabled:opacity-70">
      <div className="grid gap-7 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-7">
          <label className="block text-sm font-bold">Title<input className={`${comicInput} mt-2`} maxLength={120} onChange={(event) => edit((current) => ({ ...current, title: event.target.value }))} placeholder="Give your story a title" value={manifest.title} /></label>
          <label className="block text-sm font-bold">Description<textarea className={`${comicInput} mt-2`} maxLength={2000} onChange={(event) => edit((current) => ({ ...current, description: event.target.value }))} rows={3} value={manifest.description} /></label>
          <label className="block text-sm font-bold">Visibility<select className={`${comicInput} mt-2`} onChange={(event) => edit((current) => ({ ...current, visibility: comicManifestSchema.shape.visibility.parse(event.target.value) }))} value={manifest.visibility}><option value="private">Private — only you</option><option value="unlisted">Unlisted — readers with the link, after review</option><option value="public">Public — community discovery, after review</option></select></label>
          <label className="flex items-start gap-3 text-sm leading-6"><input className="mt-1 size-5 shrink-0 accent-pink-400" checked={manifest.allowRemix} onChange={(event) => edit((current) => ({ ...current, allowRemix: event.target.checked }))} type="checkbox" /><span><strong>Allow readers to remix these pages</strong><br /><span className="text-neutral-300">After publication, readers may use these images as references for their own creations. Your original Gallery images remain private.</span></span></label>
          {manifest.episodes.map((episode, episodeIndex) => <section className="rounded-xl border border-white/15 p-4 md:p-5" key={episodeIndex}>
            <header className="mb-5 flex flex-wrap items-center gap-3"><label className="min-w-0 flex-1 text-sm font-bold">Chapter {episodeIndex + 1}<input aria-label={`Chapter ${episodeIndex + 1} title`} className={`${comicInput} mt-2`} maxLength={120} onChange={(event) => editEpisode(episodeIndex, (current) => ({ ...current, title: event.target.value }))} value={episode.title} /></label>
              <button aria-label={`Move chapter ${episodeIndex + 1} up`} className={comicButton} disabled={episodeIndex === 0} onClick={() => { edit((current) => ({ ...current, episodes: move(current.episodes, episodeIndex, episodeIndex - 1) })); setChapter(0); }} type="button"><ArrowUp size={16} /></button>
              <button aria-label={`Move chapter ${episodeIndex + 1} down`} className={comicButton} disabled={episodeIndex === manifest.episodes.length - 1} onClick={() => { edit((current) => ({ ...current, episodes: move(current.episodes, episodeIndex, episodeIndex + 1) })); setChapter(0); }} type="button"><ArrowDown size={16} /></button>
              <button aria-label={`Remove chapter ${episodeIndex + 1}`} className={comicButton} disabled={manifest.episodes.length === 1} onClick={() => { edit((current) => ({ ...current, episodes: current.episodes.filter((_, index) => index !== episodeIndex) })); setChapter(0); }} type="button"><Trash2 size={16} /></button>
            </header>
            {!episode.pages.length && <p className="py-5 text-sm text-neutral-300">Choose this chapter in the Gallery panel, then add a page.</p>}
            <ol className="space-y-5">{episode.pages.map((page, pageIndex) => <li className="grid min-w-0 gap-4 sm:grid-cols-[100px_minmax(0,1fr)]" key={`${page.mediaAssetId}-${pageIndex}`}>
              <div className="relative aspect-[3/4] max-w-32 rounded-lg bg-white/5">{previews.get(page.mediaAssetId) ? <Image alt={`Page ${pageIndex + 1} preview`} className="rounded-lg object-cover" fill sizes="100px" src={previews.get(page.mediaAssetId)!} unoptimized /> : <p className="p-3 text-xs text-pink-200">Unavailable page — remove it before saving.</p>}</div>
              <div className="min-w-0"><label className="text-sm font-bold">Page {pageIndex + 1} caption<textarea className={`${comicInput} mt-2`} maxLength={600} onChange={(event) => editEpisode(episodeIndex, (current) => ({ ...current, pages: current.pages.map((item, index) => index === pageIndex ? { ...item, caption: event.target.value } : item) }))} rows={2} value={page.caption} /></label>
                <div className="mt-2 flex flex-wrap gap-2"><button aria-label={`Move page ${pageIndex + 1} up in chapter ${episodeIndex + 1}`} className={comicButton} disabled={pageIndex === 0} onClick={() => editEpisode(episodeIndex, (current) => ({ ...current, pages: move(current.pages, pageIndex, pageIndex - 1) }))} type="button"><ArrowUp size={16} /></button><button aria-label={`Move page ${pageIndex + 1} down in chapter ${episodeIndex + 1}`} className={comicButton} disabled={pageIndex === episode.pages.length - 1} onClick={() => editEpisode(episodeIndex, (current) => ({ ...current, pages: move(current.pages, pageIndex, pageIndex + 1) }))} type="button"><ArrowDown size={16} /></button><button aria-label={`Remove page ${pageIndex + 1} from chapter ${episodeIndex + 1}`} className={comicButton} onClick={() => editEpisode(episodeIndex, (current) => ({ ...current, pages: current.pages.filter((_, index) => index !== pageIndex) }))} type="button"><Trash2 size={16} /></button></div>
              </div>
            </li>)}</ol>
          </section>)}
          <button className={comicButton} disabled={manifest.episodes.length >= 20} onClick={() => edit((current) => ({ ...current, episodes: [...current.episodes, { title: `Chapter ${current.episodes.length + 1}`, pages: [] }] }))} type="button"><Plus size={16} />Add chapter</button>
        </div>
        <aside className="min-w-0"><h2 className="text-xl font-bold">Your Gallery</h2><p className="mt-2 text-sm leading-6 text-neutral-300">Select images to add them as pages. Original images remain in your Gallery.</p>
          <label className="mt-4 block text-sm font-bold">Add images to<select className={`${comicInput} mt-2`} onChange={(event) => setChapter(Number(event.target.value))} value={chapter}>{manifest.episodes.map((episode, index) => <option key={index} value={index}>{index + 1}. {episode.title}</option>)}</select></label>
          {galleryError && <p className="mt-4 text-pink-200" role="alert">{galleryError} <button className="underline" onClick={() => void loadGallery()} type="button">Retry Gallery</button></p>}
          <div className="mt-4 grid grid-cols-2 gap-3">{gallery.filter((item) => !item.isSynthetic).map((item, index) => <button aria-label={`Add Gallery image ${index + 1} to chapter ${chapter + 1}`} className="relative aspect-square overflow-hidden rounded-lg border border-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-40" disabled={pageCount >= 200 || (manifest.episodes[chapter]?.pages.length ?? 0) >= 50} key={item.id} onClick={() => editEpisode(chapter, (current) => ({ ...current, pages: [...current.pages, { mediaAssetId: item.id, caption: "" }] }))} type="button"><Image alt="" fill sizes="150px" className="object-cover" src={item.thumbnailUrl || item.url} unoptimized /><span className="absolute bottom-0 inset-x-0 bg-black/75 p-2 text-xs font-bold">Add page</span></button>)}</div>
          {galleryLoading && <p className="mt-4 text-sm" role="status">Loading Gallery…</p>}
          {!galleryLoading && !galleryError && !gallery.length && <p className="mt-4 text-sm text-neutral-300">Your Gallery has no images yet. <Link className="text-white underline" href="/generate">Generate an image</Link> to start your story.</p>}
          {galleryCursor && <button className={`${comicButton} mt-4`} disabled={galleryLoading} onClick={() => void loadGallery(galleryCursor)} type="button">Load more images</button>}
        </aside>
      </div>
    </fieldset>
    <div className="sticky bottom-16 mt-8 flex flex-wrap items-center gap-3 border-t border-white/15 bg-[rgb(13,13,13)] py-4 md:bottom-0">
      <button className={`${comicButton} bg-white text-black hover:bg-neutral-200`} disabled={disabled} onClick={() => void write("save")} type="button">{writing ? "Saving…" : "Save draft"}</button>
      {comic?.status === "draft" && <button className={comicButton} disabled={writing || dirty || comic.visibility === "private" || pageCount === 0} onClick={() => void write("submit")} type="button">Submit for review</button>}
      <p className="text-sm text-neutral-300">{dirty ? "Unsaved changes. Save before submitting." : `${pageCount} pages · ${manifest.episodes.length} chapters`}</p>
    </div>
  </div></ComicShell>;
}
