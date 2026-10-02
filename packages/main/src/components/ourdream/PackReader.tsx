"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { packDetailSchema, type PackDetail } from "@idream/shared/packs";
import { useViewerGate } from "@/hooks/useViewerGate";
import { useViewerResource } from "@/hooks/useViewerResource";
import { apiEnvelopeErrorMessage, isAbortError } from "@/lib/viewer-resource-client";
import { useAgeGateAccess } from "./AgeGateBoundary";
import { authHrefForTarget } from "./authRedirect";
import { PackShell } from "./PackShell";
import { packButton, packPayload, packStateLabel } from "./pack-client";

const parseDetail = packPayload(packDetailSchema);
export function PackReader({ id, releaseId }: { id: string; releaseId?: string }) {
  const { accepted } = useAgeGateAccess(); const viewer = useViewerGate({ require: "any" });
  const path = `/packs/${encodeURIComponent(id)}${releaseId ? `?release=${encodeURIComponent(releaseId)}` : ""}`;
  const apiPath = `/api/v1${path}`;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [withdrawConfirm, setWithdrawConfirm] = useState(false);
  const alive = useRef(true), serial = useRef(0), writing = useRef(false);
  const reader = useViewerResource({ request: () => ({ path: apiPath, init: { cache: "no-store" } }), parse: parseDetail, fallbackError: "Pack could not load.", initialData: null as PackDetail | null, gate: viewer.gate, snapshotKey: () => path, initialSnapshotKey: path });
  const refresh = reader.refresh;
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current += 1; }; }, []);
  useEffect(() => viewer.gate.onOwnerChange?.(() => { serial.current += 1; setError(""); setMessage(""); setBusy(false); setWithdrawConfirm(false); }), [viewer.gate]);
  useEffect(() => { if (!accepted) return; const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [accepted, refresh, viewer.revalidation]);
  const pack = reader.status.error ? null : reader.data;
  async function write(action: "claim" | "withdraw") {
    if (!pack || writing.current || (action === "claim" && !pack.release)) return;
    const ticket = ++serial.current; writing.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const response = await viewer.fetch(`/api/v1/packs/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "claim" ? { releaseId: pack.release!.id, version: pack.release!.version } : { version: pack.version }) });
      const raw: unknown = await response.json(); if (!alive.current || ticket !== serial.current) return;
      if (!response.ok) throw new Error(apiEnvelopeErrorMessage(raw) ?? "Pack changed. Reload and try again.");
      const result = parseDetail(raw); setMessage(action === "claim" ? `Edition ${result.grant!.version} claimed. Your receipt is saved.` : "Withdrawn. New claims have stopped; existing claims keep their edition."); setWithdrawConfirm(false); await refresh();
    } catch (cause) { if (alive.current && ticket === serial.current && !isAbortError(cause)) setError(cause instanceof Error ? cause.message : "Pack could not update."); }
    finally { writing.current = false; if (alive.current && ticket === serial.current) setBusy(false); }
  }
  return <PackShell path={path}><article className="mx-auto max-w-4xl">
    {(reader.status.error || viewer.error) && <div role="alert"><p>{reader.status.error || viewer.error}</p><button className={`${packButton} mt-4`} onClick={() => { void viewer.revalidate(); void refresh(); }} type="button">Reload Pack</button></div>}{reader.status.phase === "loading" && !pack && <p role="status">Loading Pack…</p>}
    {pack && <><header className="mb-8"><h1 className="text-4xl font-black md:text-5xl">{pack.release?.title ?? pack.title}</h1><p className="mt-4 text-sm text-neutral-300">By {pack.creator.displayName} · {pack.itemCount} assets · Free{pack.release ? ` · Edition ${pack.release.version}` : ""}</p><p className="mt-3 text-sm text-neutral-400">{packStateLabel(pack.status, pack.visibility)}</p><p className="mt-4 whitespace-pre-line leading-7 text-neutral-200">{pack.release?.description ?? pack.description}</p>{pack.coverUrl && !pack.release?.canAccess && <Image className="mt-6 h-auto max-h-96 w-full rounded-xl object-contain" src={pack.coverUrl} alt="Public Pack preview cover" width={1024} height={768} unoptimized />}</header>
    <section className="mb-7 rounded-xl border border-white/10 p-5" aria-label="Pack access"><p className="text-sm leading-6 text-neutral-300">Personal viewing and download of this exact listed edition. Future content and new editions are excluded.{pack.release?.claimUntil ? ` New claims close ${new Date(pack.release.claimUntil).toLocaleString()}.` : ""}</p>
    {pack.status === "blocked" ? <div className="mt-3 text-pink-200" role="alert"><p>This Pack is blocked. Its files cannot be opened.{pack.grant ? " Your existing receipt is retained." : ""}</p>{pack.blockedReason && <p className="mt-2">{pack.blockedReason}</p>}<Link className="mt-3 inline-block underline" href={`/helpdesk?subject=${encodeURIComponent(`Pack ${id} access`)}`}>Contact support</Link></div> : pack.grant ? null : pack.canClaim && pack.release ? viewer.identity?.kind === "anonymous" ? <Link className={`${packButton} mt-4`} href={authHrefForTarget("/login", path)}>Sign in to claim this free Pack</Link> : <button className={`${packButton} mt-4`} disabled={busy} onClick={() => void write("claim")} type="button">{busy ? "Claiming…" : "Claim free Pack"}</button> : <p className="mt-3 text-sm text-neutral-400">{pack.canManage ? "This edition is available to you as its creator." : "This edition is no longer open for new claims."}</p>}
    {pack.grant && <p className="mt-3 text-sm" role="status">Claim receipt: {pack.grant.id} · Edition {pack.grant.version} · {new Date(pack.grant.claimedAt).toLocaleString()}</p>}
    {pack.canManage && <div className="mt-4 flex flex-wrap gap-3"><Link className={packButton} href={`/packs/${encodeURIComponent(id)}/edit`}>Manage Pack</Link>{pack.status === "published" && (withdrawConfirm ? <><span className="w-full text-sm text-neutral-300">Stop new claims? Existing claims keep their content.</span><button className={packButton} disabled={busy} onClick={() => void write("withdraw")} type="button">Confirm withdrawal</button><button className={packButton} disabled={busy} onClick={() => setWithdrawConfirm(false)} type="button">Cancel</button></> : <button className={packButton} disabled={busy} onClick={() => setWithdrawConfirm(true)} type="button">Withdraw Pack</button>)}</div>}
    </section>{error && <p className="mb-5 text-pink-200" role="alert">{error} <button className="underline" disabled={busy} onClick={() => void refresh()} type="button">Reload current edition</button></p>}{message && <p className="mb-5 text-neutral-300" role="status">{message}</p>}
    {pack.grants.length > 0 && <nav className="mb-7 flex flex-wrap gap-3" aria-label="Your claimed editions">{pack.grants.map(grant => <Link className={packButton} href={grant.href} key={grant.id}>Claimed edition {grant.version}</Link>)}</nav>}
    <h2 className="mb-4 text-2xl font-bold">Included content</h2><ol className="space-y-6">{pack.release?.items.map((item, index) => <li className="rounded-xl border border-white/10 p-4" key={item.id}><h3 className="mb-3 text-lg font-bold">{index + 1}. {item.caption || `${item.type} asset`}</h3>{item.url ? <>{item.type === "image" ? <Image className="h-auto w-full rounded-lg" src={item.url} alt={item.caption || `Pack image ${index + 1}`} width={1024} height={768} unoptimized /> : item.type === "video" ? <video aria-label={item.caption || `Pack video ${index + 1}`} className="max-h-[70vh] w-full rounded-lg" controls playsInline preload="metadata" src={item.url} /> : <audio aria-label={item.caption || `Pack audio ${index + 1}`} className="w-full" controls preload="metadata" src={item.url} />}{item.downloadUrl && <a className={`${packButton} mt-4`} href={item.downloadUrl}>Download asset {index + 1}</a>}</> : <p className="text-sm text-neutral-400">{pack.status === "blocked" ? `Access blocked${pack.grant ? " · receipt retained" : ""}` : "Claim this free edition to view and download."}</p>}</li>)}</ol>{!pack.release && <p className="text-neutral-300">This saved draft has not been published. Open Manage Pack to prepare its first edition.</p>}
    </>}
  </article></PackShell>;
}
