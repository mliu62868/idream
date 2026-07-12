"use client";

import Link from "next/link";
import {
  creativeRunDetailSchema,
  creativeRunListResponseSchema,
  type CreativeRun,
  type CreativeRunDetail,
} from "@idream/shared/admin";
import { ArrowLeft, Check, ImageIcon, Plus, RefreshCcw, RotateCcw, Send, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { AdminSubview } from "@/components/admin/nav-config";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import { EmptyWorkspace, LoadingWorkspace, StatusBadge, WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";
import { adminV2Request } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";

type Permissions = { read: boolean; write: boolean; review: boolean; place: boolean; manageIncident?: boolean };

function denied() {
  return <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-8"><ShieldAlert className="h-6 w-6" /><h2 className="mt-4 text-lg font-semibold">No permission</h2><p className="mt-2 text-sm text-[var(--ad-text-muted)]">creative.run.read is required for this workspace.</p></section>;
}

function CreateRunForm({ enabled }: { enabled: boolean }) {
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("feed");
  const [targetType, setTargetType] = useState("character");
  const [targetId, setTargetId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [count, setCount] = useState("4");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const result = await adminV2Request<{ batch: { id: string }; replayed: boolean }>(
        "/api/v2/admin/creative/runs",
        {
          method: "POST",
          idempotencyKey: crypto.randomUUID(),
          body: {
            ...(title.trim() ? { title: title.trim() } : {}),
            purpose,
            targetType,
            ...(targetType !== "none" ? { targetId: targetId.trim() } : {}),
            profileId: profileId.trim(),
            presetIds: [],
            count: Number(count),
            brief: brief.trim(),
            consistencyMode: "balanced",
            priority: "normal",
            reason: "Launch an operator-authored Creative Run from its explicit brief",
          },
        },
      );
      window.location.assign(`/admin/creative/runs/${result.batch.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creative Run could not be launched");
    } finally {
      setBusy(false);
    }
  };
  return <section className="mt-5 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" aria-labelledby="create-creative-run-title"><h2 className="font-semibold" id="create-creative-run-title">Brief & launch</h2><p className="mt-1 text-xs text-[var(--ad-text-muted)]">Creates the Run, immutable item lineage, first Attempts, and durable generation intents in one transaction.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Title<input className={`${fieldClass} mt-1`} onChange={(event) => setTitle(event.target.value)} value={title} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Purpose<select className={`${fieldClass} mt-1`} onChange={(event) => setPurpose(event.target.value)} value={purpose}>{["character_cover", "character_hero", "character_chat", "feed", "homepage", "seo", "template_cover", "campaign", "model_eval"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target type<select className={`${fieldClass} mt-1`} onChange={(event) => setTargetType(event.target.value)} value={targetType}>{["character", "route_page", "campaign", "template", "none"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target ID<input className={`${fieldClass} mt-1`} disabled={targetType === "none"} onChange={(event) => setTargetId(event.target.value)} value={targetId} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Generation profile<input className={`${fieldClass} mt-1`} onChange={(event) => setProfileId(event.target.value)} placeholder="active profile key" value={profileId} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Items<input className={`${fieldClass} mt-1`} max={24} min={1} onChange={(event) => setCount(event.target.value)} type="number" value={count} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">Brief<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setBrief(event.target.value)} value={brief} /></label></div>{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}<WorkspaceButton disabled={busy || !profileId.trim() || !brief.trim() || (targetType !== "none" && !targetId.trim())} onClick={() => void create()} tone="primary"><Plus className="h-4 w-4" /> Create and launch</WorkspaceButton></section>;
}

function RunList({ permissions }: { permissions: Permissions }) {
  const [items, setItems] = useState<CreativeRun[]>([]);
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [cursor, setCursor] = useState<string | undefined>();
  const [pageInfo, setPageInfo] = useState<{ endCursor: string | null; hasNextPage: boolean }>({ endCursor: null, hasNextPage: false });
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next: { search: string; outcome: string; cursor?: string }, historyMode: "none" | "push" | "replace") => {
    if (!permissions.read) return;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "25" });
      if (next.search.trim()) query.set("search", next.search.trim());
      if (next.outcome !== "all") query.set("executionOutcome", next.outcome);
      if (next.cursor) query.set("cursor", next.cursor);
      if (historyMode !== "none") {
        window.history[historyMode === "push" ? "pushState" : "replaceState"](null, "", `${window.location.pathname}?${query}`);
      }
      const data = await adminV2Request(`/api/v2/admin/creative/runs?${query}`, { schema: creativeRunListResponseSchema });
      setItems([...data.items]);
      setPageInfo(data.pageInfo);
      setAsOf(data.asOf);
    } catch (cause) {
      setItems([]);
      setPageInfo({ endCursor: null, hasNextPage: false });
      setError(cause instanceof Error ? cause.message : "Creative Runs could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [permissions.read]);

  useEffect(() => {
    const restore = (historyMode: "none" | "replace") => {
      const params = new URLSearchParams(window.location.search);
      const next = {
        search: params.get("search") ?? "",
        outcome: params.get("executionOutcome") ?? "all",
        cursor: params.get("cursor") ?? undefined,
      };
      setSearch(next.search);
      setOutcome(next.outcome);
      setCursor(next.cursor);
      void load(next, historyMode);
    };
    const timer = window.setTimeout(() => restore("replace"), 0);
    const onPopState = () => restore("none");
    window.addEventListener("popstate", onPopState);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
    };
  }, [load]);

  function apply(nextCursor?: string) {
    setCursor(nextCursor);
    void load({ search, outcome, cursor: nextCursor }, "push");
  }

  if (!permissions.read) return denied();
  const filtered = Boolean(search || outcome !== "all");
  return (
    <section aria-labelledby="creative-runs-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Creative Studio</p><h2 className="mt-1 text-2xl font-semibold" id="creative-runs-title">Creative Runs</h2><p className="mt-2 max-w-2xl text-sm text-[var(--ad-text-muted)]">Execution, review, placement, and verification remain separate facts.</p></div>
        <form className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_180px_auto]" onSubmit={(event) => { event.preventDefault(); apply(); }}>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Search<input className={`${fieldClass} mt-1`} onChange={(event) => setSearch(event.target.value)} placeholder="Run, title or purpose" value={search} /></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">Outcome<select className={`${fieldClass} mt-1`} onChange={(event) => setOutcome(event.target.value)} value={outcome}>{["all", "pending", "running", "succeeded", "partially_succeeded", "failed", "cancelled"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <WorkspaceButton tone="primary" type="submit">Apply</WorkspaceButton>
        </form>
      </div>
      <CreateRunForm enabled={permissions.write} />
      {error ? <div className="mt-5 rounded-lg bg-[var(--ad-red-bg)] p-4 text-sm text-[var(--ad-red-text)]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load({ search, outcome, cursor }, "none")} type="button">Retry</button></div> : null}
      <div className="mt-6">{loading ? <LoadingWorkspace label="Loading Creative Run facts" /> : items.length === 0 ? <EmptyWorkspace filtered={filtered} onClear={() => { setSearch(""); setOutcome("all"); setCursor(undefined); void load({ search: "", outcome: "all" }, "push"); }} /> : <div className="grid gap-3">{items.map((run) => <Link className="grid gap-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 transition-colors hover:border-[var(--ad-ink)] focus-visible:outline focus-visible:outline-2 sm:grid-cols-[1fr_auto]" href={`/admin/creative/runs/${run.id}`} key={run.id}><div><div className="flex flex-wrap items-center gap-2"><strong>{run.purpose}</strong><StatusBadge value={run.executionOutcome} /><StatusBadge value={run.reviewState} /><StatusBadge value={run.deploymentState} /><StatusBadge value={run.verificationState} /></div><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{run.target.type}:{run.target.id} · {run.workflowStage} · owner {run.ownerId ?? "unassigned"}</p><div className="mt-3 flex flex-wrap gap-3 text-xs tabular-nums"><span>{run.counts.generated}/{run.counts.total} generated</span><span>{run.counts.failed} failed</span><span>{run.counts.approved} approved</span><span>{run.counts.placed} placed</span></div></div><span className="self-center text-xs text-[var(--ad-text-muted)]">Open operator flow →</span></Link>)}</div>}</div>
      <div className="mt-4 flex items-center justify-between gap-3"><p className="text-xs text-[var(--ad-text-muted)]">{asOf ? `Fresh as of ${new Date(asOf).toLocaleString()}` : "No successful query yet"}</p><WorkspaceButton disabled={loading || !pageInfo.hasNextPage || !pageInfo.endCursor} onClick={() => apply(pageInfo.endCursor ?? undefined)}>Next page</WorkspaceButton></div>
    </section>
  );
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
  const [slot, setSlot] = useState("campaign");
  const [targetType, setTargetType] = useState("character");
  const [targetId, setTargetId] = useState(run.target.id);
  const [reason, setReason] = useState("Approved candidate selected for distribution slot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!item) return <div className="mt-4"><CollaborationPanel canWrite={permissions.write} targetId={run.id} targetType="creative_run" /></div>;
  const place = async () => { if (!item.asset) return; setBusy(true); setError(null); try { await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/placements`, { method: "POST", body: { entityVersion: run.version, itemId: item.id, assetId: item.asset.id, slot, targetType, targetId, reason } }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Placement publish failed"); } finally { setBusy(false); } };
  const verify = async () => { if (!item.placement) return; setBusy(true); setError(null); try { await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/placements/${item.placement.id}/verification`, { method: "POST", body: { entityVersion: run.version, reason: "Verify the authoritative distribution slot and asset pointer" } }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Placement verification failed"); } finally { setBusy(false); } };
  return <><section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><div className="flex items-center justify-between"><h3 className="font-semibold">Placement & verification</h3>{item.placement ? <StatusBadge value={item.placement.verificationState} /> : null}</div><p className="mt-2 text-xs text-[var(--ad-text-muted)]">Release-owned slots are deliberately excluded; character avatar/hero changes require a Character Release patch.</p><div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Distribution slot<select className={`${fieldClass} mt-1`} onChange={(event) => setSlot(event.target.value)} value={slot}>{["feed_card", "homepage_strip", "seo_article", "campaign"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target type<input className={`${fieldClass} mt-1`} onChange={(event) => setTargetType(event.target.value)} value={targetType} /></label><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Target ID<input className={`${fieldClass} mt-1`} onChange={(event) => setTargetId(event.target.value)} value={targetId} /></label></div><label className="mt-3 block text-xs font-semibold text-[var(--ad-text-muted)]">Reason<textarea className={`${textAreaClass} mt-1`} onChange={(event) => setReason(event.target.value)} value={reason} /></label>{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}<div className="mt-4 flex flex-wrap gap-2"><WorkspaceButton disabled={!permissions.place || !item.asset || item.review?.decision !== "approved" || busy} onClick={() => void place()} tone="primary"><Send className="h-4 w-4" /> Publish placement</WorkspaceButton><WorkspaceButton disabled={!permissions.place || !item.placement || busy} onClick={() => void verify()}><RefreshCcw className="h-4 w-4" /> Verify live slot</WorkspaceButton></div></section><div className="mt-4"><CollaborationPanel canWrite={permissions.write} targetId={run.id} targetType="creative_run" /></div></>;
}

function IncidentAttachment({ run, permissions, reload }: { run: CreativeRunDetail; permissions: Permissions; reload: () => Promise<void> }) {
  const [incidentId, setIncidentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = async () => {
    setBusy(true); setError(null);
    try {
      await adminV2Request(`/api/v2/admin/creative/runs/${run.id}/commands/attach-incident`, {
        method: "POST",
        body: {
          entityVersion: run.version,
          incidentId: incidentId.trim(),
          reason: "Attach failed Creative Attempts to the diagnosed platform Incident",
        },
      });
      setIncidentId("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Incident attachment failed");
    } finally {
      setBusy(false);
    }
  };
  return <section className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"><h3 className="font-semibold">Related Incidents</h3><div className="mt-2 flex flex-wrap gap-2">{run.relatedIncidentIds?.length ? run.relatedIncidentIds.map((id) => <Link className="text-sm underline" href={`/admin/ops/incidents/${id}`} key={id}>{id}</Link>) : <span className="text-xs text-[var(--ad-text-muted)]">No correlated Incident</span>}</div>{permissions.manageIncident ? <div className="mt-3 flex flex-col gap-2 sm:flex-row"><label className="flex-1 text-xs font-semibold text-[var(--ad-text-muted)]">Active Incident ID<input className={`${fieldClass} mt-1`} onChange={(event) => setIncidentId(event.target.value)} value={incidentId} /></label><WorkspaceButton disabled={busy || !incidentId.trim()} onClick={() => void attach()}>Attach failed Attempts</WorkspaceButton></div> : null}{error ? <p className="mt-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}</section>;
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
  return <section aria-labelledby="creative-run-title"><Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]" href="/admin/creative/runs"><ArrowLeft className="h-4 w-4" /> Creative Runs</Link><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><p className="text-xs uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Creative Run · {run.id}</p><h2 className="mt-1 text-2xl font-semibold" id="creative-run-title">{run.title}</h2><div className="mt-2 flex flex-wrap gap-2"><StatusBadge value={run.executionOutcome} /><StatusBadge value={run.reviewState} /><StatusBadge value={run.deploymentState} /><StatusBadge value={run.verificationState} /></div></div><WorkspaceButton disabled={!permissions.write || run.counts.failed === 0 || retrying} onClick={() => void retryFailed()}><RotateCcw className="h-4 w-4" /> Retry {run.counts.failed} failed only</WorkspaceButton></div><IncidentAttachment permissions={permissions} reload={load} run={run} /><div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">{(["generated", "failed", "reviewed", "approved", "placed"] as const).map((key) => <div className="rounded-lg bg-[var(--ad-surface)] p-3" key={key}><p className="text-xs capitalize text-[var(--ad-text-muted)]">{key}</p><p className="mt-1 text-xl font-semibold tabular-nums">{run.counts[key]}<span className="text-xs font-normal text-[var(--ad-text-muted)]"> / {run.counts.total}</span></p></div>)}</div>{error ? <p className="mt-4 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}<div className="mt-5 flex gap-2 overflow-x-auto pb-2" aria-label="Creative items">{run.items.map((item, index) => <button aria-pressed={selected === index} className={cn("min-h-11 min-w-28 rounded-md border px-3 text-left text-xs focus-visible:outline focus-visible:outline-2", selected === index ? "border-[var(--ad-ink)] bg-black/[0.04]" : "border-[var(--ad-border)]")} key={item.id} onClick={() => setSelected(index)} type="button">Item {item.ordinal}<br /><span className="text-[var(--ad-text-muted)]">{item.status}</span></button>)}</div><AssetViewer onSelect={setSelected} run={run} selected={selected} /><ReviewForm itemIndex={selected} permissions={permissions} reload={load} run={run} /><PlacementForm itemIndex={selected} permissions={permissions} reload={load} run={run} /></section>;
}

export function CreativeRunWorkspace({ view, permissions }: { view: AdminSubview; permissions: Permissions }) {
  return view.kind === "detail" ? <RunDetail id={view.id} permissions={permissions} /> : <RunList permissions={permissions} />;
}
