"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCcw, X } from "lucide-react";
import {
  incidentListResponseSchema,
  type AdminListResponse,
  type OpsIncident,
} from "@idream/shared/admin";
import { adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { buildIncidentQuery, type IncidentQueryDraft } from "./query";
import {
  EmptyWorkspace,
  fieldClass,
  LoadingWorkspace,
  RelativeTime,
  StatusBadge,
  textAreaClass,
  WorkspaceButton,
} from "../operations/WorkspaceUi";

type IncidentList = AdminListResponse<OpsIncident>;

type IncidentDetail = {
  incident: OpsIncident;
  occurrences: Array<{
    id: string;
    requestId: string;
    attemptId: string | null;
    observedAt: string;
  }>;
  actionPlans: IncidentPlan[];
  activity: Array<{ id: string; action: string; reason: string | null; createdAt: string }>;
};

type IncidentPlan = {
  id: string;
  action: "retry_eligible" | "refund" | "pause_route" | "rollback";
  incidentVersion: number;
  eligibleIds?: string[];
  eligibleOccurrenceIds?: string[];
  skippedIds?: string[];
  skippedOccurrenceIds?: string[];
  expiresAt: string;
};

const initialQuery: IncidentQueryDraft = {
  search: "",
  status: "",
  severity: "",
  ownerId: "",
  limit: 30,
};

export function IncidentWorkspace({ canManage }: { canManage: boolean }) {
  const [query, setQuery] = useState<IncidentQueryDraft>(() => queryFromLocation());
  const [list, setList] = useState<IncidentList | null>(null);
  const [selectedId, setSelectedId] = useState(() => valueFromLocation("incident"));
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const firstQuery = useRef(query);
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadList = useCallback(async (next: IncidentQueryDraft, append = false) => {
    const requestId = ++listRequestId.current;
    setLoading(!append);
    setError(null);
    try {
      const response = await adminV2Request<IncidentList>(
        `/api/v2/admin/incidents?${buildIncidentQuery(next)}`,
        { schema: incidentListResponseSchema },
      );
      if (requestId !== listRequestId.current) return;
      setList((current) => append && current
        ? { ...response, items: [...current.items, ...response.items] }
        : response);
    } catch (loadError) {
      if (requestId === listRequestId.current) setError(message(loadError));
    } finally {
      if (requestId === listRequestId.current) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (incidentId: string) => {
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    setError(null);
    try {
      const response = await adminV2Request<IncidentDetail>(`/api/v2/admin/incidents/${encodeURIComponent(incidentId)}`);
      if (requestId === detailRequestId.current) setDetail(response);
    } catch (loadError) {
      if (requestId === detailRequestId.current) setError(message(loadError));
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadList(firstQuery.current); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadList]);
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => { void loadDetail(selectedId); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail, selectedId]);

  function applyFilters(event?: FormEvent) {
    event?.preventDefault();
    const next = { ...query, cursor: undefined };
    setQuery(next);
    updateUrl(next, selectedId);
    void loadList(next);
  }

  function clearFilters() {
    setQuery(initialQuery);
    updateUrl(initialQuery, selectedId);
    void loadList(initialQuery);
  }

  function selectIncident(id: string | null) {
    detailRequestId.current += 1;
    setSelectedId(id);
    setDetail(null);
    updateUrl(query, id);
  }

  async function mutate(label: string, execute: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await execute();
      setNotice(label);
      await Promise.all([loadList({ ...query, cursor: undefined }), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
    } catch (mutationError) {
      setError(message(mutationError));
    } finally {
      setBusy(false);
    }
  }

  const filtered = Boolean(query.search || query.status || query.severity || query.ownerId);

  return (
    <section aria-labelledby="incident-workspace-title" className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold tracking-[0.16em] text-[var(--ad-text-muted)]">PLATFORM OPERATIONS</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em]" id="incident-workspace-title">Incidents</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">
            Correlated failures, frozen mitigation scope, and recovery evidence in one operational root.
          </p>
        </div>
        {list ? (
          <p className="text-xs text-[var(--ad-text-muted)]" role="status">
            {list.freshness} · data as of <time dateTime={list.asOf}>{new Date(list.asOf).toLocaleTimeString()}</time>
          </p>
        ) : null}
      </header>

      <form className="grid gap-3 rounded-xl bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_repeat(3,180px)_auto]" onSubmit={applyFilters}>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
          Search all incidents
          <input className={fieldClass} onChange={(event) => setQuery({ ...query, search: event.target.value })} placeholder="signature or suspected cause" value={query.search} />
        </label>
        <Select label="Status" onChange={(status) => setQuery({ ...query, status })} options={["", "detected", "triaged", "mitigating", "monitoring", "resolved", "closed"]} value={query.status} />
        <Select label="Severity" onChange={(severity) => setQuery({ ...query, severity })} options={["", "critical", "high", "medium", "low"]} value={query.severity} />
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
          Owner ID
          <input className={fieldClass} onChange={(event) => setQuery({ ...query, ownerId: event.target.value })} value={query.ownerId} />
        </label>
        <div className="flex items-end gap-2"><WorkspaceButton tone="primary" type="submit">Apply</WorkspaceButton>{filtered ? <WorkspaceButton onClick={clearFilters}>Clear</WorkspaceButton> : null}</div>
      </form>

      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</div> : null}
      {notice ? <div className="rounded-md bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]" role="status">{notice}</div> : null}

      {loading && !list ? <LoadingWorkspace label="Loading correlated incidents" /> : list && list.items.length === 0 ? (
        <EmptyWorkspace filtered={filtered} onClear={clearFilters} />
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(440px,1.08fr)]">
          <div className="space-y-2" aria-label="Incident results">
            {list?.items.map((incident) => (
              <button
                aria-current={selectedId === incident.id ? "true" : undefined}
                className="group w-full rounded-lg bg-[var(--ad-surface)] p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--ad-shadow-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
                key={incident.id}
                onClick={() => selectIncident(incident.id)}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="truncate font-mono text-xs text-[var(--ad-text-muted)]">{incident.signature.slice(0, 18)}</p><p className="mt-1 line-clamp-2 text-sm font-semibold">{incident.suspectedCause ?? "Cause not yet established"}</p></div>
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ad-text-muted)] transition group-hover:translate-x-0.5" />
                </div>
                <div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={incident.severity} /><StatusBadge value={incident.status} /><StatusBadge value={incident.recoveryVerification.state} /></div>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-xs"><Stat label="Requests" value={incident.impact.affectedRequests} /><Stat label="Users" value={incident.impact.affectedUsers} /><Stat label="Last seen" value={<RelativeTime referenceTime={list.asOf} value={incident.lastSeenAt} />} /></dl>
              </button>
            ))}
            {list?.pageInfo.hasNextPage && list.pageInfo.endCursor ? (
              <WorkspaceButton disabled={loading} onClick={() => void loadList({ ...query, cursor: list.pageInfo.endCursor ?? undefined }, true)}><RefreshCcw className="h-4 w-4" />Load more</WorkspaceButton>
            ) : null}
          </div>

          {selectedId ? (
            detailLoading && !detail ? <LoadingWorkspace label="Loading incident detail" /> : detail ? (
              <IncidentInspector busy={busy} canManage={canManage} detail={detail} key={detail.incident.id} onClose={() => selectIncident(null)} onMutate={mutate} />
            ) : null
          ) : (
            <aside className="hidden rounded-xl bg-[var(--ad-surface-subtle)] p-8 text-sm text-[var(--ad-text-muted)] xl:block">Select an incident to inspect occurrences, mitigation scope, and recovery evidence.</aside>
          )}
        </div>
      )}
    </section>
  );
}

function IncidentInspector({ busy, canManage, detail, onClose, onMutate }: {
  busy: boolean;
  canManage: boolean;
  detail: IncidentDetail;
  onClose: () => void;
  onMutate: (label: string, execute: () => Promise<unknown>) => Promise<void>;
}) {
  const incident = detail.incident;
  const [ownerId, setOwnerId] = useState(incident.ownerId ?? "");
  const [severity, setSeverity] = useState(incident.severity);
  const [cause, setCause] = useState(incident.suspectedCause ?? "");
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<IncidentPlan["action"]>("retry_eligible");
  const [targetVersion, setTargetVersion] = useState(incident.rollbackTarget ?? "");
  const [plan, setPlan] = useState<IncidentPlan | null>(null);
  const [planIdempotencyKey, setPlanIdempotencyKey] = useState(() => crypto.randomUUID());
  const [resolveIdempotencyKey] = useState(() => crypto.randomUUID());
  const [confirmation, setConfirmation] = useState("");
  const [evidence, setEvidence] = useState("");

  const expectedPlanConfirmation = plan ? `${incident.id}:${plan.id}:${plan.action}` : "";
  const canVerify = ["mitigating", "monitoring"].includes(incident.status);
  const canResolve = incident.status === "monitoring" && ["passed", "overridden"].includes(incident.recoveryVerification.state);

  return (
    <aside aria-labelledby="incident-detail-title" className="rounded-xl bg-[var(--ad-surface)] shadow-[0_18px_50px_rgb(45_42_34/0.08)] xl:sticky xl:top-40">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--ad-border)] p-5">
        <div className="min-w-0"><p className="font-mono text-xs text-[var(--ad-text-muted)]">{incident.id}</p><h3 className="mt-1 text-lg font-semibold" id="incident-detail-title">{incident.suspectedCause ?? "Incident under investigation"}</h3><div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={incident.severity} /><StatusBadge value={incident.status} /></div></div>
        <button aria-label="Close incident detail" className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
      </header>

      <div className="space-y-5 p-5">
        <section aria-labelledby="incident-impact-title"><h4 className="text-sm font-semibold" id="incident-impact-title">Impact and recovery</h4><dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Requests" value={incident.impact.affectedRequests} /><Stat label="Users" value={incident.impact.affectedUsers} /><Stat label="Occurrences" value={detail.occurrences.length} /><Stat label="Verification" value={incident.recoveryVerification.state} /></dl></section>

        <details className="rounded-lg bg-[var(--ad-surface-subtle)] p-4" open><summary className="cursor-pointer text-sm font-semibold">Occurrences ({detail.occurrences.length})</summary><ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">{detail.occurrences.map((occurrence) => <li className="flex items-center justify-between gap-3 border-b border-[var(--ad-border)] pb-2 text-xs last:border-0" key={occurrence.id}><span className="truncate font-mono">{occurrence.requestId}</span><RelativeTime referenceTime={incident.updatedAt} value={occurrence.observedAt} /></li>)}</ul></details>

        {canManage ? (
          <>
            <form className="space-y-3 border-t border-[var(--ad-border)] pt-5" onSubmit={(event) => { event.preventDefault(); void onMutate("Incident triage saved", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}`, { method: "PATCH", body: { entityVersion: incident.version, ownerId: ownerId.trim() || null, severity, suspectedCause: cause.trim() || undefined, reason: reason.trim() } })); }}>
              <h4 className="text-sm font-semibold">Triage</h4>
              <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Owner ID<input className={fieldClass} onChange={(event) => setOwnerId(event.target.value)} value={ownerId} /></label><Select label="Severity" onChange={(value) => setSeverity(value as OpsIncident["severity"])} options={["critical", "high", "medium", "low"]} value={severity} /></div>
              <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Suspected cause<textarea className={textAreaClass} onChange={(event) => setCause(event.target.value)} value={cause} /></label>
              <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Audit reason<input className={fieldClass} onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
              <WorkspaceButton disabled={busy || reason.trim().length < 3} tone="primary" type="submit">Save triage</WorkspaceButton>
            </form>

            <section className="space-y-3 border-t border-[var(--ad-border)] pt-5" aria-labelledby="mitigation-plan-title"><h4 className="text-sm font-semibold" id="mitigation-plan-title">Mitigation plan</h4><div className="grid gap-3 sm:grid-cols-2"><Select label="Action" onChange={(value) => { setAction(value as IncidentPlan["action"]); setPlan(null); }} options={["retry_eligible", "refund", "pause_route", "rollback"]} value={action} /><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Rollback target<input className={fieldClass} disabled={action !== "rollback"} onChange={(event) => setTargetVersion(event.target.value)} value={targetVersion} /></label></div>
              <WorkspaceButton disabled={busy || (action === "rollback" && !targetVersion.trim())} onClick={() => void onMutate("Frozen mitigation preview created", async () => { const next = await adminV2Request<IncidentPlan>(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/action-plans/preview`, { method: "POST", body: { action, targetVersion: action === "rollback" ? targetVersion : undefined } }); setPlan(next); setPlanIdempotencyKey(crypto.randomUUID()); })}>Preview eligible scope</WorkspaceButton>
              {plan ? <div className="rounded-md bg-[var(--ad-yellow-bg)] p-3 text-sm"><p><strong>{plan.eligibleIds?.length ?? plan.eligibleOccurrenceIds?.length ?? 0}</strong> eligible · <strong>{plan.skippedIds?.length ?? plan.skippedOccurrenceIds?.length ?? 0}</strong> skipped</p><code className="mt-2 block break-all text-xs">{expectedPlanConfirmation}</code><label className="mt-3 grid gap-1 text-xs font-semibold">Type confirmation<input className={fieldClass} onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label><div className="mt-3"><WorkspaceButton disabled={busy || confirmation !== expectedPlanConfirmation} tone="danger" onClick={() => void onMutate("Mitigation plan executed", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/action-plans/${encodeURIComponent(plan.id)}/execute`, { method: "POST", idempotencyKey: planIdempotencyKey, body: { entityVersion: incident.version, confirmation } }))}>Execute frozen plan</WorkspaceButton></div></div> : null}
            </section>

        <section className="space-y-3 border-t border-[var(--ad-border)] pt-5" aria-labelledby="incident-verification-title"><h4 className="text-sm font-semibold" id="incident-verification-title">Recovery verification</h4><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Evidence reference<input className={fieldClass} onChange={(event) => setEvidence(event.target.value)} placeholder="monitor, dashboard, or runbook reference" value={evidence} /></label><p className="text-xs leading-5 text-[var(--ad-text-muted)]">Passing records all five required checks: success rate, signature growth, backlog, failed-request plan, and settlement.</p><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || !canVerify || !evidence.trim()} onClick={() => void onMutate("Recovery verification recorded", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/verification`, { method: "POST", body: { entityVersion: incident.version, state: "passed", evidenceRefs: [evidence.trim()], checks: { successRateRecovered: true, signatureGrowthStopped: true, backlogRecovering: true, failedRequestPlanComplete: true, settlementReconciled: true } } }))}><CheckCircle2 className="h-4 w-4" />Mark recovery verified</WorkspaceButton><WorkspaceButton disabled={busy || !canResolve || reason.trim().length < 3} tone="primary" onClick={() => void onMutate("Incident resolve command accepted", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/commands/resolve`, { method: "POST", idempotencyKey: resolveIdempotencyKey, body: { entityVersion: incident.version, reason: { code: "recovery_verified", summary: reason.trim() }, confirmation: `${incident.id}:resolve` } }))}>Resolve incident</WorkspaceButton></div>{!canVerify ? <p className="text-xs text-[var(--ad-yellow-text)]"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Execute mitigation before verification.</p> : null}</section>
          </>
        ) : <p className="rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">Read access only. Incident actions require <code>ops.incident.manage</code>.</p>}
      </div>
    </aside>
  );
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string }) {
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className={fieldClass} onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? option.replaceAll("_", " ") : "All"}</option>)}</select></label>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{label}</dt><dd className="mt-1 font-mono text-sm text-[var(--ad-ink)]">{value}</dd></div>;
}

function queryFromLocation(): IncidentQueryDraft {
  if (typeof window === "undefined") return initialQuery;
  const params = new URLSearchParams(window.location.search);
  return { ...initialQuery, search: params.get("search") ?? "", status: params.get("status") ?? "", severity: params.get("severity") ?? "", ownerId: params.get("ownerId") ?? "" };
}

function valueFromLocation(key: string) {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(key);
}

function updateUrl(query: IncidentQueryDraft, selectedId: string | null) {
  const params = new URLSearchParams(buildIncidentQuery({ ...query, cursor: undefined }));
  params.delete("limit");
  if (selectedId) params.set("incident", selectedId);
  setWorkspaceUrl(params);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Incident operation failed";
}
