"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { packDetailSchema, packManifestSchema, packSourcesSchema, type PackDetail, type PackManifest } from "@idream/shared/packs";
import { useViewerGate } from "@/hooks/useViewerGate";
import { apiEnvelopeErrorMessage, isAbortError, loadViewerResource } from "@/lib/viewer-resource-client";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { PackShell } from "./PackShell";
import { packButton, packInput, packPayload, packStateLabel } from "./pack-client";

const empty: PackManifest = { title: "", description: "", visibility: "private", items: [], coverAssetId: null, claimUntil: null };
const parseDetail = packPayload(packDetailSchema), parseSources = packPayload(packSourcesSchema);
type Source = ReturnType<typeof parseSources>["items"][number];
function localDeadline(value: string | null) {
  if (!value) return ""; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function PackStudio({ id }: { id?: string }) {
  const { accepted } = useAgeGateAccess(); const viewer = useViewerGate(); const gatedFetch = viewer.fetch;
  const [pack, setPack] = useState<PackDetail | null>(null), [manifest, setManifest] = useState<PackManifest>(empty);
  const [sources, setSources] = useState<Source[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(id)), [sourceLoading, setSourceLoading] = useState(false), [sourceError, setSourceError] = useState("");
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [identityChanged, setIdentityChanged] = useState(false);
  const alive = useRef(true), serial = useRef(0), sourceSerial = useRef(0), dirtyRef = useRef(false), writing = useRef(false);
  const markDirty = useCallback((value: boolean) => { dirtyRef.current = value; setDirty(value); }, []);
  const load = useCallback(async () => {
    if (!id) return; const ticket = ++serial.current; setLoading(true); setError(""); setPack(null); setManifest(empty); markDirty(false);
    const result = await loadViewerResource({ path: `/api/v1/packs/${encodeURIComponent(id)}`, parse: parseDetail, fallbackError: "Pack could not load.", init: { cache: "no-store" }, isCurrent: () => alive.current && ticket === serial.current }, gatedFetch);
    if (result.kind === "discarded") return; setLoading(false);
    if (result.kind === "failed") { setError(result.error); return; }
    if (!result.data.canManage || !result.data.manifest) { setError("Only this Pack's creator can edit it."); return; }
    setPack(result.data); setManifest(result.data.manifest);
  }, [gatedFetch, id, markDirty]);
  const loadSources = useCallback(async (nextCursor?: string) => {
    const ticket = ++sourceSerial.current; setSourceLoading(true); setSourceError("");
    const query = new URLSearchParams(); if (nextCursor) query.set("cursor", nextCursor);
    const result = await loadViewerResource({ path: `/api/v1/packs/sources${query.size ? `?${query}` : ""}`, parse: parseSources, fallbackError: "Gallery could not load.", init: { cache: "no-store" }, isCurrent: () => alive.current && ticket === sourceSerial.current }, gatedFetch);
    if (result.kind === "discarded") return; setSourceLoading(false);
    if (result.kind === "failed") { setSourceError(result.error); return; }
    setSources(current => nextCursor ? [...current, ...result.data.items.filter(item => !current.some(old => old.id === item.id))] : result.data.items); setCursor(result.data.nextCursor);
  }, [gatedFetch]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current += 1; sourceSerial.current += 1; }; }, []);
  useEffect(() => viewer.gate.onOwnerChange?.(() => {
    serial.current += 1; sourceSerial.current += 1; setPack(null); setManifest(empty); setSources([]); setCursor(null); setIdentityChanged(true); markDirty(false); setError("The signed-in account changed. Reload the editor to continue.");
  }), [markDirty, viewer.gate]);
  const confirmed = viewer.identity !== null, signedOut = viewer.identity?.kind === "anonymous";
  useEffect(() => {
    if (!accepted || !confirmed || signedOut) return;
    const timer = window.setTimeout(() => { void load(); void loadSources(); }, 0); return () => window.clearTimeout(timer);
  }, [accepted, confirmed, load, loadSources, signedOut]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault(); }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, []);
  function edit(update: (current: PackManifest) => PackManifest) { setManifest(update); markDirty(true); setMessage(""); }
  function move(from: number, to: number) { edit(current => { const items = [...current.items]; const [item] = items.splice(from, 1); if (item) items.splice(to, 0, item); return { ...current, items }; }); }
  async function write(action: "save" | "publish") {
    if (writing.current || identityChanged || (action === "publish" && (!pack || dirty))) return;
    if (action === "save") { const parsed = packManifestSchema.safeParse(manifest); if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check your Pack details."); return; } }
    const ticket = ++serial.current; writing.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const base = `/api/v1/packs${id ? `/${encodeURIComponent(id)}` : ""}`;
      const response = await gatedFetch(action === "publish" ? `${base}/publish` : base, { method: action === "save" && id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "save" ? id ? { version: pack!.version, manifest } : manifest : { version: pack!.version }) });
      const raw: unknown = await response.json(); if (!alive.current || ticket !== serial.current) return;
      if (!response.ok) throw new Error(apiEnvelopeErrorMessage(raw) ?? "Pack could not save. Reload and try again.");
      const next = parseDetail(raw); setPack(next); if (next.manifest) setManifest(next.manifest); markDirty(false);
      setMessage(action === "publish" ? `Edition ${next.release!.version} published. Only these listed assets are included.` : "Draft saved.");
      if (!id) window.location.assign(`/packs/${encodeURIComponent(next.id)}/edit`);
    } catch (cause) { if (alive.current && ticket === serial.current && !isAbortError(cause)) setError(cause instanceof Error ? cause.message : "Pack could not save."); }
    finally { writing.current = false; if (alive.current && ticket === serial.current) setBusy(false); }
  }
  const editable = !pack || ["draft", "withdrawn"].includes(pack.status), disabled = busy || loading || identityChanged || !editable || Boolean(id && !pack);
  const path = id ? `/packs/${encodeURIComponent(id)}/edit` : "/packs/new";
  if (identityChanged) return <PackShell path={path}><p role="alert">The signed-in account changed. Reload the editor to continue.</p><button className={`${packButton} mt-5`} onClick={() => window.location.reload()} type="button">Reload editor</button></PackShell>;
  if (signedOut) return <PackShell path={path}><h1 className="mb-5 text-4xl font-black">Create a Pack</h1><Link className={packButton} href={authHrefForTarget("/login", path)}>Sign in to create or edit a Pack</Link></PackShell>;
  return <PackShell path={path}><div className="mx-auto max-w-5xl"><header className="mb-8"><h1 className="text-4xl font-black">{id ? "Edit Pack" : "Create a Pack"}</h1><p className="mt-3 max-w-prose text-neutral-300">Choose and order current images, videos and audio from your Gallery. Free claims allow personal viewing and download. Future content is excluded.</p>{pack && <p className="mt-3 text-sm text-neutral-400">{packStateLabel(pack.status, pack.visibility)} · Saved version {pack.version}</p>}</header>
    {(error || viewer.error) && <p className="mb-5 text-pink-200" role="alert">{error || viewer.error}{id && <button className="ml-3 underline" disabled={busy} onClick={() => void load()} type="button">Reload saved Pack</button>}</p>}{message && <p className="mb-5 text-neutral-300" role="status">{message}</p>}{loading && <p role="status">Loading saved Pack…</p>}
    {pack && !editable && <p className="mb-5 text-neutral-300">{pack.status === "blocked" ? "This Pack is blocked. Contact support before changing it." : "Withdraw this Pack before editing a new edition."} <Link className="underline" href={`/packs/${encodeURIComponent(pack.id)}`}>Open Pack</Link></p>}
    <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><section className="space-y-5"><label className="block font-semibold">Pack title<input className={`${packInput} mt-2`} disabled={disabled} maxLength={120} onChange={event => edit(current => ({ ...current, title: event.target.value }))} value={manifest.title} /></label><label className="block font-semibold">Description<textarea className={`${packInput} mt-2`} disabled={disabled} maxLength={2000} rows={3} onChange={event => edit(current => ({ ...current, description: event.target.value }))} value={manifest.description} /></label>
    <label className="block font-semibold">Audience<select className={`${packInput} mt-2`} disabled={disabled} onChange={event => edit(current => ({ ...current, visibility: packManifestSchema.shape.visibility.parse(event.target.value) }))} value={manifest.visibility}><option value="private">Only you</option><option value="unlisted">Anyone with the link can claim</option><option value="public">Public discovery and free claims</option></select></label>
    <label className="block font-semibold">Claim deadline (your local time, optional)<input className={`${packInput} mt-2`} disabled={disabled} type="datetime-local" value={localDeadline(manifest.claimUntil)} onChange={event => { const date = event.target.value ? new Date(event.target.value) : null; if (date && Number.isNaN(date.getTime())) return; edit(current => ({ ...current, claimUntil: date?.toISOString() ?? null })); }} /></label><p className="text-sm text-neutral-400">The deadline stops new claims. Existing claims keep their exact edition. Files can be up to 50 MB each and 200 MB in total.</p>
    <label className="block font-semibold">Public preview cover<select className={`${packInput} mt-2`} disabled={disabled} value={manifest.coverAssetId ?? ""} onChange={event => edit(current => ({ ...current, coverAssetId: event.target.value || null }))}><option value="">No public cover</option>{manifest.coverAssetId && !sources.some(source => source.id === manifest.coverAssetId) && <option value={manifest.coverAssetId}>Saved cover · load more Gallery items to preview</option>}{manifest.items.flatMap((item, index) => sources.some(source => source.id === item.mediaAssetId && source.type === "image") ? [<option key={item.mediaAssetId} value={item.mediaAssetId}>{`${index + 1}. ${item.caption.trim() || "Image"}`}</option>] : [])}</select></label><p className="text-sm text-neutral-400">For a shared Pack, anyone can view this cover without a claim. All other files require a claim.</p>
    <div className="flex flex-wrap gap-3"><button className={packButton} disabled={disabled} onClick={() => void write("save")} type="button">{busy ? "Saving…" : "Save draft"}</button><button className={packButton} disabled={disabled || dirty || !pack || pack.status !== "draft" || !manifest.items.length} onClick={() => void write("publish")} type="button">Publish saved edition</button>{id && <Link className={packButton} href={`/packs/${encodeURIComponent(id)}`}>Open Pack</Link>}</div>{dirty && <p className="text-sm text-neutral-400">Save your changes before publishing.</p>}</section>
    <section><h2 className="mb-3 text-2xl font-bold">Included assets · {manifest.items.length}/16</h2><ol className="mb-7 space-y-4">{manifest.items.map((item, index) => <li className="rounded-xl border border-white/10 p-3" key={item.mediaAssetId}><p className="mb-2 text-sm text-neutral-400">{index + 1}. {sources.find(source => source.id === item.mediaAssetId)?.type ?? "Saved asset"}</p><label className="block text-sm font-semibold">Caption {index + 1}<textarea className={`${packInput} mt-2`} disabled={disabled} maxLength={600} rows={2} value={item.caption} onChange={event => edit(current => ({ ...current, items: current.items.map((old, n) => n === index ? { ...old, caption: event.target.value } : old) }))} /></label><div className="mt-3 flex flex-wrap gap-2"><button aria-label={`Move asset ${index + 1} up`} className={packButton} disabled={disabled || index === 0} onClick={() => move(index, index - 1)} type="button">Up</button><button aria-label={`Move asset ${index + 1} down`} className={packButton} disabled={disabled || index === manifest.items.length - 1} onClick={() => move(index, index + 1)} type="button">Down</button><button aria-label={`Remove asset ${index + 1}`} className={packButton} disabled={disabled} onClick={() => edit(current => ({ ...current, coverAssetId: current.coverAssetId === item.mediaAssetId ? null : current.coverAssetId, items: current.items.filter(old => old.mediaAssetId !== item.mediaAssetId) }))} type="button">Remove</button></div></li>)}</ol>
    <h2 className="mb-3 text-2xl font-bold">Choose from your Gallery</h2>{sourceError && <p role="alert" className="mb-4 text-pink-200">{sourceError} <button className="underline" disabled={sourceLoading} onClick={() => void loadSources()} type="button">Retry Gallery</button></p>}{sourceLoading && <p role="status">Loading Gallery…</p>}{!sourceLoading && !sourceError && !sources.length && <p className="text-neutral-300">No available assets yet. <Link className="underline" href="/generate">Generate images, video or audio</Link> to add content.</p>}
    <ul className="grid gap-3 sm:grid-cols-2">{sources.map((source, sourceIndex) => { const selected = manifest.items.some(item => item.mediaAssetId === source.id); return <li key={source.id}><label className="block rounded-lg border border-white/10 p-3"><span className="flex items-center gap-3"><input aria-label={`Include Gallery ${source.type} ${sourceIndex + 1}`} checked={selected} disabled={disabled || (!selected && manifest.items.length >= 16)} type="checkbox" onChange={event => edit(current => ({ ...current, coverAssetId: !event.target.checked && current.coverAssetId === source.id ? null : current.coverAssetId, items: event.target.checked ? [...current.items, { mediaAssetId: source.id, caption: "" }] : current.items.filter(item => item.mediaAssetId !== source.id) }))} /><span className="text-sm font-bold capitalize">{source.type}</span></span>{source.type === "image" ? <Image className="mt-3 h-32 w-full rounded-lg object-cover" src={source.url} alt="Your Gallery image" height={256} width={256} unoptimized /> : source.type === "video" ? <video className="mt-3 max-h-36 w-full" controls preload="none" src={source.url} /> : <audio className="mt-3 w-full" controls preload="none" src={source.url} />}</label></li>; })}</ul>{cursor && <button className={`${packButton} mt-4`} disabled={sourceLoading || busy} onClick={() => void loadSources(cursor)} type="button">Load more Gallery assets</button>}</section></div>
  </div></PackShell>;
}
