"use client";

import Link from "next/link";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ClipboardCheck, RefreshCcw, X } from "lucide-react";
import {
  APPEAL_CASE_DECISIONS,
  BILLING_CASE_ACTIONS,
  CONTENT_REPORT_CASE_DECISIONS,
  operationsCaseListResponseSchema,
  SUPPORT_CASE_ACTIONS,
  type AdminListResponse,
  type OperationsCase,
} from "@idream/shared/admin";
import { adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import { SavedViewsControl } from "@/features/collaboration/SavedViewsControl";
import {
  caseQueryFromSavedState,
  caseSavedState,
  type SavedViewRecord,
} from "@/features/collaboration/saved-views";
import { buildCaseQuery, type CaseQueryDraft } from "./query";
import {
  EmptyWorkspace,
  fieldClass,
  LoadingWorkspace,
  RelativeTime,
  StatusBadge,
  textAreaClass,
  WorkspaceButton,
} from "../operations/WorkspaceUi";

type CaseList = AdminListResponse<OperationsCase>;

type CaseEvidence = {
  id: string;
  source: { type: string; id: string };
  evidenceType: string;
  summary: string;
  occurredAt: string;
  access: "full" | "redacted";
};

type CaseDetail = {
  case: OperationsCase;
  evidence: CaseEvidence[];
  decisions: Array<{ id: string; decision: string; question: string; createdAt: string; confidence?: number | null }>;
  activity: Array<{ id: string; action: string; reason: string | null; createdAt: string }>;
};

const views = ["mine", "unassigned", "overdue", "appeals", "recently_resolved", "all"] as const;

const initialQuery: CaseQueryDraft = {
  view: "mine",
  search: "",
  type: "",
  status: "",
  priority: "",
  ownerId: "",
  sort: "updated_desc",
  limit: 30,
};

export function CaseWorkspace({ canAssign, canDecide, initialCaseId = null }: { canAssign: boolean; canDecide: boolean; initialCaseId?: string | null }) {
  const [query, setQuery] = useState<CaseQueryDraft>(() => queryFromLocation());
  const [list, setList] = useState<CaseList | null>(null);
  const [selectedId, setSelectedId] = useState(() => initialCaseId ?? valueFromLocation("case"));
  const [selectedSavedViewId, setSelectedSavedViewId] = useState(() => valueFromLocation("savedView"));
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const firstQuery = useRef(query);
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadList = useCallback(async (next: CaseQueryDraft, append = false) => {
    const requestId = ++listRequestId.current;
    setLoading(!append);
    setError(null);
    try {
      const response = await adminV2Request<CaseList>(`/api/v2/admin/cases?${buildCaseQuery(next)}`, {
        schema: operationsCaseListResponseSchema,
      });
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

  const loadDetail = useCallback(async (caseId: string) => {
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    setError(null);
    try {
      const response = await adminV2Request<CaseDetail>(`/api/v2/admin/cases/${encodeURIComponent(caseId)}`);
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
    setSelectedSavedViewId(null);
    setQuery(next);
    updateUrl(next, selectedId, null);
    void loadList(next);
  }

  function selectView(view: string) {
    const next = { ...query, view, cursor: undefined };
    setSelectedSavedViewId(null);
    setQuery(next);
    updateUrl(next, selectedId, null);
    void loadList(next);
  }

  function clearFilters() {
    const next = { ...initialQuery, view: query.view };
    setSelectedSavedViewId(null);
    setQuery(next);
    updateUrl(next, selectedId, null);
    void loadList(next);
  }

  function selectCase(id: string | null) {
    detailRequestId.current += 1;
    setSelectedId(id);
    setDetail(null);
    updateUrl(query, id, selectedSavedViewId);
  }

  const applySavedView = useCallback((view: SavedViewRecord) => {
    const next = caseQueryFromSavedState(view.queryState);
    setSelectedSavedViewId(view.id);
    setQuery(next);
    updateUrl(next, selectedId, view.id);
    void loadList(next);
  }, [loadList, selectedId]);

  const selectSavedView = useCallback((id: string | null) => {
    setSelectedSavedViewId(id);
  }, []);

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

  const filtered = Boolean(query.search || query.type || query.status || query.priority || query.ownerId);

  return (
    <section aria-labelledby="case-workspace-title" className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div><p className="text-xs font-semibold tracking-[0.16em] text-[var(--ad-text-muted)]">CUSTOMER OPERATIONS</p><h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em]" id="case-workspace-title">Cases</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">Evidence, decision, downstream verification, and closure stay attached to the customer problem.</p></div>
        {list ? <p className="text-xs text-[var(--ad-text-muted)]" role="status">{list.freshness} · data as of <time dateTime={list.asOf}>{new Date(list.asOf).toLocaleTimeString()}</time></p> : null}
      </header>

      <CaseTabs active={query.view} onChange={selectView} />

      <SavedViewsControl
        currentState={caseSavedState(query)}
        onApply={applySavedView}
        onSelectedChange={selectSavedView}
        scope="case"
        selectedId={selectedSavedViewId}
      />

      <form className="grid gap-3 rounded-xl bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_repeat(4,150px)_auto]" onSubmit={applyFilters}>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Search all cases<input className={fieldClass} onChange={(event) => setQuery({ ...query, search: event.target.value })} placeholder="target or case key" value={query.search} /></label>
        <Select label="Type" onChange={(type) => setQuery({ ...query, type })} options={["", "content_report", "appeal", "support_request", "billing_dispute"]} value={query.type} />
        <Select label="Status" onChange={(status) => setQuery({ ...query, status })} options={["", "new", "triaged", "in_progress", "waiting", "resolved", "closed", "reopened"]} value={query.status} />
        <Select label="Priority" onChange={(priority) => setQuery({ ...query, priority })} options={["", "urgent", "high", "normal", "low"]} value={query.priority} />
        <Select label="Sort" onChange={(sort) => setQuery({ ...query, sort: sort as CaseQueryDraft["sort"] })} options={["updated_desc", "updated_asc"]} value={query.sort} />
        <div className="flex items-end gap-2"><WorkspaceButton tone="primary" type="submit">Apply</WorkspaceButton>{filtered ? <WorkspaceButton onClick={clearFilters}>Clear</WorkspaceButton> : null}</div>
      </form>

      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</div> : null}
      {notice ? <div className="rounded-md bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]" role="status">{notice}</div> : null}

      {loading && !list ? <LoadingWorkspace label="Loading cases" /> : list && list.items.length === 0 ? <EmptyWorkspace filtered={filtered} onClear={clearFilters} /> : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(460px,1.08fr)]">
          <div className="space-y-2" aria-label="Case results">
            {list?.items.map((adminCase) => <CaseRow adminCase={adminCase} active={selectedId === adminCase.id} key={adminCase.id} onSelect={() => selectCase(adminCase.id)} referenceTime={list.asOf} />)}
            {list?.pageInfo.hasNextPage && list.pageInfo.endCursor ? <WorkspaceButton disabled={loading} onClick={() => void loadList({ ...query, cursor: list.pageInfo.endCursor ?? undefined }, true)}><RefreshCcw className="h-4 w-4" />Load more</WorkspaceButton> : null}
          </div>
          {selectedId ? detailLoading && !detail ? <LoadingWorkspace label="Loading case detail" /> : detail ? <CaseInspector busy={busy} canAssign={canAssign} canDecide={canDecide} detail={detail} key={detail.case.id} onClose={() => selectCase(null)} onMutate={mutate} /> : null : <aside className="hidden rounded-xl bg-[var(--ad-surface-subtle)] p-8 text-sm text-[var(--ad-text-muted)] xl:block">Select a case to inspect evidence and complete the decision loop.</aside>}
        </div>
      )}
    </section>
  );
}

function CaseTabs({ active, onChange }: { active: string; onChange: (view: string) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + direction + views.length) % views.length;
    refs.current[next]?.focus();
    onChange(views[next]);
  }
  return <div aria-label="Case queue views" className="flex gap-1 overflow-x-auto rounded-lg bg-[var(--ad-surface-subtle)] p-1" role="group">{views.map((view, index) => <button aria-pressed={active === view} className={`min-h-11 shrink-0 rounded-md px-3 text-sm font-semibold transition ${active === view ? "bg-[var(--ad-surface)] text-[var(--ad-ink)] shadow-sm" : "text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"}`} key={view} onClick={() => onChange(view)} onKeyDown={(event) => onKeyDown(event, index)} ref={(node) => { refs.current[index] = node; }} type="button">{view.replaceAll("_", " ")}</button>)}</div>;
}

function CaseRow({ active, adminCase, onSelect, referenceTime }: { active: boolean; adminCase: OperationsCase; onSelect: () => void; referenceTime: string }) {
  const overdue = new Date(adminCase.slaDueAt).getTime() < new Date(referenceTime).getTime() && !["resolved", "closed"].includes(adminCase.status);
  return <button aria-current={active ? "true" : undefined} className="group w-full rounded-lg bg-[var(--ad-surface)] p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--ad-shadow-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]" onClick={onSelect} type="button"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--ad-text-muted)]">{adminCase.type.replaceAll("_", " ")} · {adminCase.target.type}</p><p className="mt-1 truncate font-mono text-sm font-semibold">{adminCase.target.id}</p></div><ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ad-text-muted)] transition group-hover:translate-x-0.5" /></div><div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={adminCase.priority} /><StatusBadge value={adminCase.status} />{overdue ? <StatusBadge tone="bad" value="overdue" /> : null}</div><dl className="mt-4 grid grid-cols-3 gap-3"><Stat label="Evidence" value={adminCase.reportCount + adminCase.messageCount} /><Stat label="Owner" value={adminCase.ownerId ?? "unassigned"} /><Stat label="SLA" value={<RelativeTime referenceTime={referenceTime} value={adminCase.slaDueAt} />} /></dl></button>;
}

function CaseInspector({ busy, canAssign, canDecide, detail, onClose, onMutate }: { busy: boolean; canAssign: boolean; canDecide: boolean; detail: CaseDetail; onClose: () => void; onMutate: (label: string, execute: () => Promise<unknown>) => Promise<void> }) {
  const adminCase = detail.case;
  const defaultEvidence = detail.evidence.map((item) => item.id).join(", ");
  const [ownerId, setOwnerId] = useState(adminCase.ownerId ?? "");
  const [priority, setPriority] = useState(adminCase.priority);
  const [reason, setReason] = useState("");
  const customerCase = adminCase.type === "support_request" || adminCase.type === "billing_dispute";
  const operationOptions = adminCase.type === "content_report"
    ? CONTENT_REPORT_CASE_DECISIONS
    : adminCase.type === "appeal"
      ? APPEAL_CASE_DECISIONS
      : adminCase.type === "billing_dispute"
        ? BILLING_CASE_ACTIONS
        : SUPPORT_CASE_ACTIONS;
  const [decision, setDecision] = useState<string>(operationOptions[0]);
  const [summary, setSummary] = useState(adminCase.resolutionSummary ?? "");
  const [outcomeRef, setOutcomeRef] = useState("");
  const [evidenceRefs, setEvidenceRefs] = useState(defaultEvidence);
  const [confirmation, setConfirmation] = useState("");
  const [lifecycleConfirmation, setLifecycleConfirmation] = useState("");
  const [verificationOverrideReason, setVerificationOverrideReason] = useState("");
  const [resumeAt, setResumeAt] = useState("");
  const [closeIdempotencyKey] = useState(() => crypto.randomUUID());
  const refs = evidenceRefs.split(",").map((item) => item.trim()).filter(Boolean);
  const closeConfirmation = `${adminCase.id}:close`;
  const canClose = adminCase.status === "resolved" && ["passed", "overridden"].includes(adminCase.verification?.state ?? "");

  return <aside aria-labelledby="case-detail-title" className="rounded-xl bg-[var(--ad-surface)] shadow-[0_18px_50px_rgb(45_42_34/0.08)] xl:sticky xl:top-40"><header className="flex items-start justify-between gap-4 border-b border-[var(--ad-border)] p-5"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--ad-text-muted)]">{adminCase.type.replaceAll("_", " ")}</p><h3 className="mt-1 truncate font-mono text-lg font-semibold" id="case-detail-title">{adminCase.target.id}</h3><div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={adminCase.priority} /><StatusBadge value={adminCase.status} />{adminCase.verification ? <StatusBadge value={adminCase.verification.state} /> : null}</div></div><button aria-label="Close case detail" className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]" onClick={onClose} type="button"><X className="h-4 w-4" /></button></header>
    <div className="space-y-5 p-5">
      <section aria-labelledby="case-summary-title"><h4 className="text-sm font-semibold" id="case-summary-title">Summary</h4><dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Owner" value={adminCase.ownerId ?? "unassigned"} /><Stat label="SLA" value={<RelativeTime referenceTime={adminCase.updatedAt} value={adminCase.slaDueAt} />} /><Stat label="Version" value={adminCase.version} /><Stat label="Evidence" value={detail.evidence.length} /></dl>{adminCase.resolutionSummary ? <p className="mt-3 rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]">{adminCase.resolutionSummary}</p> : null}</section>

      {adminCase.relatedIncidentIds.length > 0 || adminCase.relatedCaseIds.length > 0 ? <nav aria-label="Related operational records" className="rounded-md bg-[var(--ad-surface-subtle)] p-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">Related records</h4><div className="mt-2 flex flex-wrap gap-2">{adminCase.relatedIncidentIds.map((id) => <Link className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs font-semibold hover:border-[var(--ad-ink)]" href={`/admin/ops/incidents/${encodeURIComponent(id)}`} key={id}>Incident {id}</Link>)}{adminCase.relatedCaseIds.map((id) => <Link className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs font-semibold hover:border-[var(--ad-ink)]" href={`/admin/cases?case=${encodeURIComponent(id)}`} key={id}>Case {id}</Link>)}</div></nav> : null}

      <section aria-labelledby="case-evidence-title"><div className="flex items-center justify-between"><h4 className="text-sm font-semibold" id="case-evidence-title">Evidence</h4><span className="text-xs text-[var(--ad-text-muted)]">immutable sources</span></div><ol className="mt-3 space-y-2">{detail.evidence.map((item) => <li className="rounded-md bg-[var(--ad-surface-subtle)] p-3" key={item.id}><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs">{item.id}</span><span className="text-xs text-[var(--ad-text-muted)]"><RelativeTime referenceTime={adminCase.updatedAt} value={item.occurredAt} /></span></div><p className="mt-2 text-sm leading-6">{item.summary}</p><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{item.evidenceType} · {item.access}</p></li>)}</ol></section>

      {canAssign ? <form className="space-y-3 border-t border-[var(--ad-border)] pt-5" onSubmit={(event) => { event.preventDefault(); void onMutate("Case assignment saved", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/assignment`, { method: "POST", body: { entityVersion: adminCase.version, ownerId: ownerId.trim() || null, priority, reason: reason.trim() } })); }}><h4 className="text-sm font-semibold">Assignment</h4><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Owner ID<input className={fieldClass} onChange={(event) => setOwnerId(event.target.value)} value={ownerId} /></label><Select label="Priority" onChange={(value) => setPriority(value as OperationsCase["priority"])} options={["urgent", "high", "normal", "low"]} value={priority} /></div><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Audit reason<input className={fieldClass} onChange={(event) => setReason(event.target.value)} required value={reason} /></label><WorkspaceButton disabled={busy || reason.trim().length < 3} tone="primary" type="submit">Save assignment</WorkspaceButton></form> : null}

      {canAssign || canDecide ? <section className="space-y-3 border-t border-[var(--ad-border)] pt-5"><h4 className="text-sm font-semibold">Lifecycle</h4><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Resume after (optional)<input className={fieldClass} onChange={(event) => setResumeAt(event.target.value)} type="datetime-local" value={resumeAt} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Type lifecycle confirmation<input className={fieldClass} onChange={(event) => setLifecycleConfirmation(event.target.value)} value={lifecycleConfirmation} /></label><div className="flex flex-wrap gap-2">{canAssign && ["new", "triaged", "in_progress", "reopened"].includes(adminCase.status) ? <WorkspaceButton disabled={busy || reason.trim().length < 3 || lifecycleConfirmation !== `${adminCase.id}:wait`} onClick={() => void onMutate("Case moved to waiting", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/commands/wait`, { method: "POST", body: { entityVersion: adminCase.version, reason: reason.trim(), resumeAt: resumeAt ? new Date(resumeAt).toISOString() : undefined, confirmation: lifecycleConfirmation } }))}>Wait for dependency</WorkspaceButton> : null}{canDecide && ["resolved", "closed"].includes(adminCase.status) ? <WorkspaceButton disabled={busy || reason.trim().length < 3 || lifecycleConfirmation !== `${adminCase.id}:reopen`} onClick={() => void onMutate("Case reopened or recurrence created", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/commands/reopen`, { method: "POST", body: { entityVersion: adminCase.version, reason: reason.trim(), confirmation: lifecycleConfirmation } }))}>Reopen / create recurrence</WorkspaceButton> : null}</div><p className="text-xs text-[var(--ad-text-muted)]">Expected: <code>{adminCase.id}:{["resolved", "closed"].includes(adminCase.status) ? "reopen" : "wait"}</code></p></section> : null}

      {canDecide ? <section className="space-y-4 border-t border-[var(--ad-border)] pt-5" aria-labelledby="case-decision-title"><h4 className="text-sm font-semibold" id="case-decision-title">Decision and verification</h4><Select label={customerCase ? "Customer action" : "Decision"} onChange={setDecision} options={operationOptions} value={decision} />{customerCase ? <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Outcome reference<input className={fieldClass} onChange={(event) => setOutcomeRef(event.target.value)} placeholder={adminCase.type === "billing_dispute" ? "ledger:&lt;id&gt;, refund:&lt;id&gt;, or subscription:&lt;id&gt;:&lt;status&gt;" : "incident:&lt;id&gt; or an override-only operational reference"} value={outcomeRef} /></label> : null}<label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Resolution summary<textarea className={textAreaClass} onChange={(event) => setSummary(event.target.value)} value={summary} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Evidence IDs (comma separated)<input className={fieldClass} onChange={(event) => setEvidenceRefs(event.target.value)} value={evidenceRefs} /></label><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || !decision || !summary.trim() || refs.length === 0 || (customerCase && !outcomeRef.trim())} onClick={() => void onMutate(customerCase ? "Customer Case action recorded" : "Case decision recorded", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/${customerCase ? "actions" : "decisions"}`, { method: "POST", body: customerCase ? { entityVersion: adminCase.version, action: decision, summary: summary.trim(), evidenceRefs: refs, outcomeRef: outcomeRef.trim() } : { entityVersion: adminCase.version, decision, summary: summary.trim(), evidenceRefs: refs } }))}><ClipboardCheck className="h-4 w-4" />{customerCase ? "Record action" : "Record decision"}</WorkspaceButton><WorkspaceButton disabled={busy || !adminCase.resolutionSummary || refs.length === 0} onClick={() => void onMutate("Downstream outcome verified", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/verification`, { method: "POST", body: { entityVersion: adminCase.version, state: "passed", evidenceRefs: refs } }))}><CheckCircle2 className="h-4 w-4" />Verify from authority</WorkspaceButton></div><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Override reason (only when automatic verification is unavailable)<textarea className={textAreaClass} onChange={(event) => setVerificationOverrideReason(event.target.value)} value={verificationOverrideReason} /></label><WorkspaceButton disabled={busy || !adminCase.resolutionSummary || refs.length === 0 || verificationOverrideReason.trim().length < 3} onClick={() => void onMutate("Case verification explicitly overridden", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/verification`, { method: "POST", body: { entityVersion: adminCase.version, state: "overridden", evidenceRefs: refs, overrideReason: verificationOverrideReason.trim() } }))}>Override verification</WorkspaceButton>
        <div className="rounded-md bg-[var(--ad-surface-subtle)] p-3"><code className="block break-all text-xs">{closeConfirmation}</code><label className="mt-3 grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">Type confirmation<input className={fieldClass} onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label><div className="mt-3"><WorkspaceButton disabled={busy || !canClose || confirmation !== closeConfirmation || reason.trim().length < 3} tone="danger" onClick={() => void onMutate("Case close command accepted", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/commands/close`, { method: "POST", idempotencyKey: closeIdempotencyKey, body: { entityVersion: adminCase.version, reason: { code: "outcome_verified", summary: reason.trim() }, confirmation } }))}>Close case</WorkspaceButton></div></div>
      </section> : <p className="rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">Read access only. Decisions require <code>case.decide</code>.</p>}
      <CollaborationPanel canWrite={canAssign} targetId={adminCase.id} targetType="case" />
    </div></aside>;
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: readonly string[]; value: string }) { return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className={fieldClass} onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? option.replaceAll("_", " ") : "All"}</option>)}</select></label>; }
function Stat({ label, value }: { label: string; value: ReactNode }) { return <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{label}</dt><dd className="mt-1 truncate font-mono text-sm text-[var(--ad-ink)]" title={typeof value === "string" ? value : undefined}>{value}</dd></div>; }
function queryFromLocation(): CaseQueryDraft { if (typeof window === "undefined") return initialQuery; const params = new URLSearchParams(window.location.search); const view = params.get("view"); const sort = params.get("sort"); return { ...initialQuery, view: views.includes(view as (typeof views)[number]) ? view ?? "mine" : "mine", search: params.get("search") ?? "", type: params.get("type") ?? "", status: params.get("status") ?? "", priority: params.get("priority") ?? "", ownerId: params.get("ownerId") ?? "", sort: sort === "updated_asc" ? "updated_asc" : "updated_desc", limit: boundedLimit(params.get("limit"), initialQuery.limit) }; }
function valueFromLocation(key: string) { return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(key); }
function updateUrl(query: CaseQueryDraft, selectedId: string | null, savedViewId: string | null) { const params = new URLSearchParams(buildCaseQuery({ ...query, cursor: undefined })); if (selectedId) params.set("case", selectedId); if (savedViewId) params.set("savedView", savedViewId); setWorkspaceUrl(params); }
function boundedLimit(value: string | null, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 && parsed <= 200 ? parsed : fallback; }
function message(error: unknown) { return error instanceof Error ? error.message : "Case operation failed"; }
