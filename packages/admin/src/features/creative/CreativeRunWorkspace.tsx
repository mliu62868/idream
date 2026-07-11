"use client";

import Link from "next/link";
import {
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import { ArrowLeft, Check, ImageIcon, RefreshCcw, RotateCcw, Send, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { EmptyWorkspace, LoadingWorkspace, StatusBadge, WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";
import { adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";

type Permissions = { read: boolean; write: boolean; review: boolean; place: boolean };

function denied() {
  return <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"><ShieldAlert className="h-6 w-6" /><h2 className="mt-4 text-lg font-semibold">No permission</h2><p className="mt-2 text-sm text-[var(--ad-text-muted)]">creative.run.read is required for this workspace.</p></section>;
}

function RunList({ permissions }: { permissions: Permissions }) {
  const [items, setItems] = useState<CreativeRun[]>([]);
  const [search, setSearch] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("search") ?? "");
  const [outcome, setOutcome] = useState(() => typeof window === "undefined" ? "all" : new URLSearchParams(window.location.search).get("executionOutcome") ?? "all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!permissions.read) return;
    setLoading(true); setError(null);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (search.trim()) query.set("search", search.trim());
      if (outcome !== "all") query.set("executionOutcome", outcome);
      setWorkspaceUrl(query);
      const data = await adminV2Request(`/api/v2/admin/creative/runs?${query}`, { schema: creativeRunListResponseSchema });
      setItems([...data.items]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Creative Runs could not be loaded"); }
    finally { setLoading(false); }
  }, [outcome, permissions.read, search]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), search.trim() ? 250 : 0); return () => window.clearTimeout(timer); }, [load, search]);
  if (!permissions.read) return denied();
  return <section aria-labelledby="creative-runs-title"><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Creative Studio</p><h1 className="mt-1 text-2xl font-semibold" id="creative-runs-title">Creative Runs</h1><p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">Execution, review, placement, and verification remain separate facts.</p></div><div className="grid gap-2 sm:grid-cols-2"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Search<input className={`${fieldClass} mt-1`} onChange={(event) => setSearch(event.target.value)} placeholder="Run, title or purpose" value={search} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Outcome<select className={`${fieldClass} mt-1`} onChange={(event) => setOutcome(event.target.value)} value={outcome}>{["all", "pending", "running", "succeeded", "partially_succeeded", "failed", "cancelled"].map((value) => <option key={value}>{value}</option>)}</select></label></div></div>{error ? <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load()} type="button">Retry</button></div> : null}<div className="mt-6">{loading ? <LoadingWorkspace label="Loading Creative Run facts" /> : items.length === 0 ? <EmptyWorkspace filtered={Boolean(search || outcome !== "all")} onClear={() => { setSearch(""); setOutcome("all"); }} /> : <div className="grid gap-3">{items.map((run) => <Link className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors hover:border-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2 sm:grid-cols-[1fr_auto]" href={`/admin/creative/runs/${run.id}`} key={run.id}><div><div className="flex flex-wrap items-center gap-2"><strong>{run.purpose}</strong><StatusBadge value={run.executionOutcome} /><StatusBadge value={run.reviewState} /><StatusBadge value={run.deploymentState} /><StatusBadge value={run.verificationState} /></div><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{run.target.type}:{run.target.id} · {run.workflowStage} · owner {run.ownerId ?? "unassigned"}</p><div className="mt-3 flex flex-wrap gap-3 text-xs tabular-nums"><span>{run.counts.generated}/{run.counts.total} generated</span><span>{run.counts.failed} failed</span><span>{run.counts.approved} approved</span><span>{run.counts.placed} placed</span></div></div><span className="self-center text-xs text-[var(--ad-text-muted)]">Open operator flow →</span></Link>)}</div>}</div></section>;
}

function AssetViewer({ run, selected, onSelect }: { run: CreativeRunDetail; selected: number; onSelect: (index: number) => void }) {
  const item = run.items[selected];
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onSelect((selected + (event.key === "ArrowRight" ? 1 : -1) + run.items.length) % run.items.length);
  };
  if (!item) return <EmptyWorkspace filtered={false} onClear={() => undefined} />;
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]" onKeyDown={move} tabIndex={0} aria-label="Creative asset viewer. Use left and right arrow keys to move between items."><div className="min-h-80 overflow-hidden rounded-xl border border-[var(--ad-border)] bg-black/[0.04]">{item.asset ? (
    // eslint-disable-next-line @next/next/no-img-element -- operator blob URLs are not compatible with Next image optimization
    <img alt={`Creative item ${item.ordinal}`} className="max-h-[70vh] w-full object-contain" src={item.asset.url} />
  ) : <div className="grid min-h-80 place-items-center text-[var(--ad-text-muted)]"><ImageIcon className="h-8 w-8" /><span>No valid artifact</span></div>}</div><aside className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><div className="flex flex-wrap gap-2"><StatusBadge value={item.status} /><StatusBadge value={item.retryability} /></div><dl className="mt-4 space-y-3 text-xs"><div><dt className="text-[var(--ad-text-muted)]">Request / attempt</dt><dd className="mt-1 break-all">{item.lineage.requestId ?? "Unavailable"}<br />{item.lineage.attemptId ?? "Unavailable"}</dd></div><div><dt className="text-[var(--ad-text-muted)]">Asset</dt><dd className="mt-1 break-all">{item.asset?.id ?? "Unavailable"}</dd></div><div><dt className="text-[var(--ad-text-muted)]">Latest review</dt><dd className="mt-1">{item.review ? `${item.review.decision} · ${item.review.identityConsistency}` : "Pending"}</dd></div><div><dt className="text-[var(--ad-text-muted)]">Placement</dt><dd className="mt-1">{item.placement ? `${item.placement.slot} · ${item.placement.verificationState}` : "Unplaced"}</dd></div></dl></aside></div>;
}

function ReviewForm({ run, itemIndex, permissions, reload }: { run: CreativeRunDetail; itemIndex: number; permissions: Permissions; reload: () => Promise<void> }) {
  const item = run.items[itemIndex];
  const [reason, setReason] = useState("Identity and composition reviewed against the Run brief");
  const [score, setScore] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!item) return null;
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true); setError(null);
    try {
      await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/items/${item.id}/decisions`, { method: "POST", body: { entityVersion: run.version, decision, identityConsistency: decision === "approved" ? "passed" : "failed", score: Number(score), reason } });
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review decision failed"); }
    finally { setBusy(false); }
  };
  return <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="creative-review-title"><h3 className="font-semibold" id="creative-review-title">Review decision</h3><div className="mt-4 grid gap-3 sm:grid-cols-[120px_1fr]"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Score<input className={`${fieldClass} mt-1`} max={100} min={0} onChange={(event) => setScore(event.target.value)} type="number" value={score} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Evidence and reason<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} /></label></div>{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}<div className="mt-4 flex flex-wrap gap-2"><WorkspaceButton disabled={!permissions.review || !item.asset || busy} onClick={() => void decide("approved")} tone="primary"><Check className="h-4 w-4" /> Approve</WorkspaceButton><WorkspaceButton disabled={!permissions.review || !item.asset || busy} onClick={() => void decide("rejected")} tone="danger"><X className="h-4 w-4" /> Reject</WorkspaceButton></div>{!permissions.review ? <p className="mt-3 text-xs text-[var(--ad-text-muted)]">creative.run.review is not granted.</p> : null}</section>;
}

function PlacementForm({ run, itemIndex, permissions, reload }: { run: CreativeRunDetail; itemIndex: number; permissions: Permissions; reload: () => Promise<void> }) {
  const item = run.items[itemIndex];
  const [slot, setSlot] = useState("feed_card");
  const [targetType, setTargetType] = useState("character");
  const [targetId, setTargetId] = useState(run.target.id);
  const [reason, setReason] = useState("Approved candidate selected for distribution slot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!item) return null;
  const place = async () => { if (!item.asset) return; setBusy(true); setError(null); try { await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/placements`, { method: "POST", body: { entityVersion: run.version, itemId: item.id, assetId: item.asset.id, slot, targetType, targetId, reason } }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Placement publish failed"); } finally { setBusy(false); } };
  const verify = async () => { if (!item.placement) return; setBusy(true); setError(null); try { await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/placements/${item.placement.id}/verification`, { method: "POST", body: { entityVersion: run.version, reason: "Verify the authoritative distribution slot and asset pointer" } }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Placement verification failed"); } finally { setBusy(false); } };
  return <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><div className="flex items-center justify-between"><h3 className="font-semibold">Placement & verification</h3>{item.placement ? <StatusBadge value={item.placement.verificationState} /> : null}</div><p className="mt-2 text-xs text-[var(--ad-text-muted)]">Release-owned slots are deliberately excluded; character avatar/hero changes require a Character Release patch.</p><div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Distribution slot<select className={`${fieldClass} mt-1`} onChange={(event) => setSlot(event.target.value)} value={slot}>{["feed_card", "homepage_strip", "seo_article", "campaign"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target type<input className={`${fieldClass} mt-1`} onChange={(event) => setTargetType(event.target.value)} value={targetType} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target ID<input className={`${fieldClass} mt-1`} onChange={(event) => setTargetId(event.target.value)} value={targetId} /></label></div><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">Reason<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} /></label>{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}<div className="mt-4 flex flex-wrap gap-2"><WorkspaceButton disabled={!permissions.place || !item.asset || item.review?.decision !== "approved" || busy} onClick={() => void place()} tone="primary"><Send className="h-4 w-4" /> Publish placement</WorkspaceButton><WorkspaceButton disabled={!permissions.place || !item.placement || busy} onClick={() => void verify()}><RefreshCcw className="h-4 w-4" /> Verify live slot</WorkspaceButton></div></section>;
}

function RunDetail({ id, permissions }: { id: string; permissions: Permissions }) {
  const [run, setRun] = useState<CreativeRunDetail | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setRun(await adminV2Request(`/api/v2/admin/creative/runs/${id}`, { schema: creativeRunDetailSchema })); } catch (cause) { setError(cause instanceof Error ? cause.message : "Creative Run could not be loaded"); } finally { setLoading(false); } }, [id]);
  useEffect(() => {
    if (!permissions.read) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, permissions.read]);
  const retryFailed = async () => { if (!run) return; setRetrying(true); setError(null); try { await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/commands/retry-failed`, { method: "POST", idempotencyKey: crypto.randomUUID(), body: { entityVersion: run.version, reason: { code: "operator_retry_failed", summary: "Retry only eligible failed Creative Run items" } } }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Failed items could not be retried"); } finally { setRetrying(false); } };
  if (!permissions.read) return denied();
  if (loading) return <LoadingWorkspace label="Loading Creative Run lineage and outcomes" />;
  if (!run) return <section className="rounded-xl bg-[var(--ad-red-bg)] p-5" role="alert">{error ?? "Creative Run not found"} <button className="ml-2 underline" onClick={() => void load()} type="button">Retry</button></section>;
  return <section aria-labelledby="creative-run-title"><Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" href="/admin/creative/runs"><ArrowLeft className="h-4 w-4" /> Creative Runs</Link><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><p className="text-xs uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Creative Run · {run.id}</p><h1 className="mt-1 text-2xl font-semibold" id="creative-run-title">{run.title}</h1><div className="mt-2 flex flex-wrap gap-2"><StatusBadge value={run.executionOutcome} /><StatusBadge value={run.reviewState} /><StatusBadge value={run.deploymentState} /><StatusBadge value={run.verificationState} /></div></div><WorkspaceButton disabled={!permissions.write || run.counts.failed === 0 || retrying} onClick={() => void retryFailed()}><RotateCcw className="h-4 w-4" /> Retry {run.counts.failed} failed only</WorkspaceButton></div><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">{(["generated", "failed", "reviewed", "approved", "placed"] as const).map((key) => <div className="rounded-lg bg-[var(--ad-surface)] p-3" key={key}><p className="text-xs capitalize text-[var(--ad-text-muted)]">{key}</p><p className="mt-1 text-xl font-semibold tabular-nums">{run.counts[key]}<span className="text-xs font-normal text-[var(--ad-text-muted)]"> / {run.counts.total}</span></p></div>)}</div>{error ? <p className="mt-4 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}<div className="mt-5 flex gap-2 overflow-x-auto pb-2" aria-label="Creative items">{run.items.map((item, index) => <button aria-pressed={selected === index} className={cn("min-h-11 min-w-28 rounded-md border px-3 text-left text-xs focus-visible:outline focus-visible:outline-2", selected === index ? "border-[var(--ad-ink)] bg-black/[0.04]" : "border-[var(--ad-border)]")} key={item.id} onClick={() => setSelected(index)} type="button">Item {item.ordinal}<br /><span className="text-[var(--ad-text-muted)]">{item.status}</span></button>)}</div><AssetViewer onSelect={setSelected} run={run} selected={selected} /><ReviewForm itemIndex={selected} permissions={permissions} reload={load} run={run} /><PlacementForm itemIndex={selected} permissions={permissions} reload={load} run={run} /></section>;
}

export function CreativeRunWorkspace({ view, permissions }: { view: AdminSubview; permissions: Permissions }) {
  return view.kind === "detail" ? <RunDetail id={view.id} permissions={permissions} /> : <RunList permissions={permissions} />;
}
