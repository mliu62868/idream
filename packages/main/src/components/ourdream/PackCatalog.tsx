"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { packListSchema, type PackSummary } from "@idream/shared/packs";
import { useViewerGate } from "@/hooks/useViewerGate";
import { loadViewerResource } from "@/lib/viewer-resource-client";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { PackShell } from "./PackShell";
import { packButton, packPayload, packStateLabel } from "./pack-client";

const parseList = packPayload(packListSchema);
export function PackCatalog({ scope = "public" }: { scope?: "public" | "mine" | "claimed" }) {
  const { accepted } = useAgeGateAccess();
  const viewer = useViewerGate({ require: "any" });
  const [items, setItems] = useState<PackSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const serial = useRef(0), alive = useRef(true);
  const gatedFetch = viewer.fetch;
  const load = useCallback(async (nextCursor?: string) => {
    const ticket = ++serial.current; setLoading(true); setError("");
    if (!nextCursor) { setItems([]); setCursor(null); }
    const query = new URLSearchParams({ scope, limit: "12" }); if (nextCursor) query.set("cursor", nextCursor);
    const result = await loadViewerResource({ path: `/api/v1/packs?${query}`, parse: parseList, fallbackError: "Packs could not load.", init: { cache: "no-store" }, isCurrent: () => alive.current && ticket === serial.current }, gatedFetch);
    if (result.kind === "discarded") return;
    setLoading(false);
    if (result.kind === "failed") { setError(result.error); return; }
    setItems(current => nextCursor ? [...current, ...result.data.items.filter(item => !current.some(old => old.id === item.id && old.releaseId === item.releaseId))] : result.data.items); setCursor(result.data.nextCursor);
  }, [gatedFetch, scope]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current += 1; }; }, []);
  useEffect(() => viewer.gate.onOwnerChange?.(() => { serial.current += 1; setItems([]); setCursor(null); setError(""); setLoading(true); }), [viewer.gate]);
  useEffect(() => {
    if (!accepted || !viewer.identity || (scope !== "public" && viewer.identity.kind === "anonymous")) return;
    const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer);
  }, [accepted, load, scope, viewer.identity, viewer.revalidation]);
  const title = scope === "mine" ? "Your Packs" : scope === "claimed" ? "Claimed Packs" : "Free Packs";
  const signedOut = scope !== "public" && viewer.identity?.kind === "anonymous";
  return <PackShell path={scope === "public" ? "/packs" : `/packs?scope=${scope}`}>
    <header className="mb-8 flex flex-wrap items-start justify-between gap-5"><div><h1 className="text-4xl font-black md:text-5xl">{title}</h1><p className="mt-3 max-w-prose leading-6 text-neutral-300">{scope === "claimed" ? "Your claims keep access to their exact edition, including after ordinary withdrawal or the claim deadline." : "A Pack includes its listed current images, videos and audio. Free claims allow personal viewing and download; future content is excluded."}</p></div><Link className={packButton} href="/packs/new">Create a Pack</Link></header>
    {(error || viewer.error) && <p className="mb-5 text-pink-200" role="alert">{error || viewer.error} <button className="underline" onClick={() => { void viewer.revalidate(); void load(); }} type="button">Retry</button></p>}
    {signedOut ? <Link className={packButton} href={authHrefForTarget("/login", `/packs?scope=${scope}`)}>Sign in to view your Packs</Link> : loading && !items.length ? <p role="status">Loading Packs…</p> : !error && !viewer.error && !items.length ? <p className="rounded-xl border border-white/10 p-6 text-neutral-300">{scope === "mine" ? "Create your first Pack from your Gallery." : scope === "claimed" ? "No claims yet. Browse free Packs to get started." : "No public Packs yet. Creators can prepare a Pack and share its listed content here."}</p> : null}
    <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">{items.map(item => <li key={`${item.id}:${item.releaseId ?? "draft"}`}><Link className="block rounded-xl border border-white/10 p-4 hover:bg-white/5" href={scope === "claimed" && item.releaseId ? `/packs/${encodeURIComponent(item.id)}?release=${encodeURIComponent(item.releaseId)}` : `/packs/${encodeURIComponent(item.id)}`}>
      {item.coverUrl && <div className="relative mb-4 aspect-[4/3] overflow-hidden rounded-lg"><Image alt="Pack preview cover" fill className="object-cover" src={item.coverUrl} sizes="(max-width:640px) 100vw, 33vw" unoptimized /></div>}<h2 className="text-xl font-bold">{item.title}</h2><p className="mt-2 text-sm text-neutral-300">{item.itemCount} assets · {item.creator.displayName} · Free{item.releaseVersion ? ` · Edition ${item.releaseVersion}` : ""}</p><p className="mt-2 text-sm text-neutral-400">{packStateLabel(item.status, item.visibility)}</p>
    </Link></li>)}</ul>{cursor && <button className={`${packButton} mt-7`} disabled={loading} onClick={() => void load(cursor)} type="button">{loading ? "Loading…" : "Load more Packs"}</button>}
  </PackShell>;
}
