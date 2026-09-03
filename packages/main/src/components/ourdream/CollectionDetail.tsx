"use client";

import Link from "next/link";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseMediaCollectionDetailResponse,
  parseMediaCollectionMutationResponse,
  parsePublicApiError,
  type CollectionDetail as CollectionDetailData,
} from "@/lib/public-api-contracts";

export function CollectionDetail({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const { accepted } = useAgeGateAccess();
  const [detail, setDetail] = useState<CollectionDetailData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [retryCursor, setRetryCursor] = useState<string | null>(null);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (cursor: string | null = null) => {
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError("");
    setRetryCursor(cursor);
    // Focus may mean another account now owns the cookie. Clear private content before revalidating.
    if (!cursor) setDetail(null);
    try {
      const search = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(`/api/v1/media/collections/${encodeURIComponent(id)}${search}`, { signal: controller.signal, cache: "no-store" });
      const body: unknown = await response.json();
      if (request !== requestRef.current) return;
      if (!response.ok) {
        if ([400, 401, 403, 404].includes(response.status)) {
          setDetail(null);
          setRetryCursor(null);
        }
        throw new Error(parsePublicApiError(body)?.message ?? "Collection could not load.");
      }
      const next = parseMediaCollectionDetailResponse(body);
      setDetail((current) => cursor && current
        ? { ...next, items: [...current.items, ...next.items.filter((item) => !current.items.some((existing) => existing.id === item.id))] }
        : next);
      if (!cursor) {
        setName(next.collection.name);
        setIsPublic(next.collection.visibility === "public");
      }
    } catch (cause) {
      if (request !== requestRef.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Collection could not load.");
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, [id]);

  useEffect(() => {
    if (!accepted) return;
    void load();
    const refresh = () => { setStatus(""); void load(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [accepted, load]);

  async function mutate(mediaId?: string) {
    if (busy || !detail?.canManage) return;
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError("");
    setStatus("");
    setRetryCursor(null);
    try {
      const endpoint = `/api/v1/media/collections/${encodeURIComponent(id)}${mediaId ? `/items/${encodeURIComponent(mediaId)}` : ""}`;
      const response = await fetch(endpoint, {
        method: mediaId ? "DELETE" : "PATCH",
        signal: controller.signal,
        ...(!mediaId ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), visibility: isPublic ? "public" : "private" }) } : {}),
      });
      const body: unknown = await response.json();
      if (request !== requestRef.current) return;
      if (!response.ok) throw new Error(parsePublicApiError(body)?.message ?? "Collection update failed.");
      parseMediaCollectionMutationResponse(body);
      onChanged?.();
      setStatus(mediaId ? "Removed from this collection. The original media stays in your Gallery." : "Collection updated.");
      await load();
    } catch (cause) {
      if (request !== requestRef.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Collection update failed.");
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }

  return (
    <section aria-label="Collection details" data-testid="collection-detail" className="mb-6 rounded-2xl border border-white/15 bg-[rgb(18,18,18)] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{detail?.collection.name ?? "Collection details"}</h2>
        <div className="flex gap-4 text-sm">
          <button disabled={busy} onClick={() => void load()} type="button">Refresh collection</button>
          <Link href="/community">All collections</Link>
        </div>
      </div>
      {status && <p role="status" className="mb-3 text-sm">{status}</p>}
      {error && <div role="alert" className="mb-3 text-sm text-rose-300"><p>{error}</p><button disabled={busy} onClick={() => void load(retryCursor)} type="button">Retry collection</button></div>}
      {busy && <p role="status" className="mb-3 text-sm text-white/60">Loading collection…</p>}
      {detail && <>
        <p className="mb-4 text-sm text-white/60">{detail.collection.itemCount} items · {detail.collection.visibility}</p>
        {detail.canManage && <form className="mb-5 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void mutate(); }}>
          <label className="grid gap-1 text-sm">Collection name<input className="rounded border border-white/20 bg-transparent p-2" disabled={busy} maxLength={80} onChange={(event) => setName(event.target.value)} value={name} /></label>
          <label className="flex gap-2 py-2 text-sm"><input checked={isPublic} disabled={busy} onChange={(event) => setIsPublic(event.target.checked)} type="checkbox" />Public in Community</label>
          <button className="rounded bg-white/10 px-3 py-2 text-sm" disabled={busy || !name.trim()} type="submit">Save collection</button>
        </form>}
        {detail.items.length === 0 ? <p className="text-sm">This collection is empty. Add media from <Link className="underline" href="/profile?tab=media">your Gallery</Link>.</p> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {detail.items.map((item, index) => <article className="overflow-hidden rounded-xl border border-white/10 p-2" data-testid="collection-detail-item" data-media-id={item.id} key={item.id}>
            {!item.url ? <div className="grid aspect-square place-items-center text-sm text-white/60">Media unavailable</div> : item.type === "video" ? <video aria-label={`Collection video ${index + 1}`} className="aspect-square w-full object-contain" controls playsInline preload="metadata" src={item.url} /> : item.type === "voice" ? <audio aria-label={`Collection audio ${index + 1}`} className="w-full" controls preload="metadata" src={item.url} /> : (
              // Native media keeps the same authenticated content URL as Gallery and supports mixed collections.
              // eslint-disable-next-line @next/next/no-img-element
              <img alt={`Collection image ${index + 1}`} className="aspect-square w-full object-contain" loading="lazy" src={item.url} />
            )}
            {detail.canManage && <button aria-label={`Remove item ${index + 1} from collection`} className="mt-2 text-sm text-rose-300" disabled={busy} onClick={() => void mutate(item.id)} type="button">Remove from collection</button>}
          </article>)}
        </div>}
        {detail.nextCursor && <button className="mt-4 rounded bg-white/10 px-4 py-2 text-sm" disabled={busy} onClick={() => void load(detail.nextCursor)} type="button">Load more items</button>}
      </>}
    </section>
  );
}
