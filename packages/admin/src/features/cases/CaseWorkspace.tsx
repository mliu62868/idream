"use client";

import { useAdminI18n } from "@/components/admin/i18n";
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
import { createWorkspaceHistoryController, observeWorkspacePopState, workspaceDetailId } from "@/lib/workspace-history";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import { SavedViewsControl } from "@/features/collaboration/SavedViewsControl";
import {
  caseQueryFromSavedState,
  caseSavedState,
  type SavedViewRecord,
} from "@/features/collaboration/saved-views";
import {
  buildCaseQuery,
  buildCaseWorkspaceParams,
  caseWorkspacePath,
  caseViews,
  defaultCaseQuery,
  parseCaseWorkspaceParams,
  type CaseQueryDraft,
  type CaseWorkspaceUrlState,
} from "./query";
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

export function CaseWorkspace({ canAssign, canDecide, initialCaseId = null }: { canAssign: boolean; canDecide: boolean; initialCaseId?: string | null }) {
  const { locale, t } = useAdminI18n();
  const [initialUrlState] = useState(() => initialCaseWorkspaceState(initialCaseId));
  const [query, setQuery] = useState<CaseQueryDraft>(initialUrlState.query);
  const [list, setList] = useState<CaseList | null>(null);
  const [selectedId, setSelectedId] = useState(initialUrlState.selectedId);
  const [selectedSavedViewId, setSelectedSavedViewId] = useState(initialUrlState.savedViewId);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const history = useRef(createWorkspaceHistoryController(initialUrlState));
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadList = useCallback(async (next: CaseQueryDraft) => {
    const requestId = ++listRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const response = await adminV2Request<CaseList>(`/api/v2/admin/cases?${buildCaseQuery(next)}`, {
        schema: operationsCaseListResponseSchema,
      });
      if (requestId !== listRequestId.current) return;
      setList(response);
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
    const timer = window.setTimeout(() => {
      const restored = stateFromLocation(initialCaseId);
      history.current.restore(restored);
      setQuery(restored.query);
      setSelectedSavedViewId(restored.savedViewId);
      setSelectedId(restored.selectedId);
      setDetail(null);
      if (!initialCaseId) history.current.replace(restored, writeCaseUrl);
      void loadList(restored.query);
      if (restored.selectedId) void loadDetail(restored.selectedId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialCaseId, loadDetail, loadList]);

  useEffect(() => {
    return observeWorkspacePopState(window, () => stateFromLocation(null), (restored) => {
      listRequestId.current += 1;
      detailRequestId.current += 1;
      setQuery(restored.query);
      history.current.restore(restored);
      setSelectedSavedViewId(restored.savedViewId);
      setSelectedId(restored.selectedId);
      setDetail(null);
      void loadList(restored.query);
      if (restored.selectedId) void loadDetail(restored.selectedId);
    });
  }, [loadDetail, loadList]);

  function updateDraft(patch: Partial<CaseQueryDraft>) {
    const next = { ...query, ...patch, cursor: undefined };
    setQuery(next);
    history.current.draft({ ...history.current.current(), query: next }, writeCaseUrl);
  }

  function applyFilters(event?: FormEvent) {
    event?.preventDefault();
    const next = { ...query, cursor: undefined };
    setSelectedSavedViewId(null);
    setQuery(next);
    history.current.navigate({ query: next, selectedId, savedViewId: null }, writeCaseUrl);
    void loadList(next);
  }

  function selectView(view: string) {
    const next = { ...query, view, cursor: undefined };
    setSelectedSavedViewId(null);
    setQuery(next);
    history.current.navigate({ query: next, selectedId, savedViewId: null }, writeCaseUrl);
    void loadList(next);
  }

  function clearFilters() {
    const next = { ...defaultCaseQuery, view: query.view };
    setSelectedSavedViewId(null);
    setQuery(next);
    history.current.navigate({ query: next, selectedId, savedViewId: null }, writeCaseUrl);
    void loadList(next);
  }

  function selectCase(id: string | null) {
    detailRequestId.current += 1;
    setSelectedId(id);
    setDetail(null);
    history.current.navigate({ ...history.current.current(), selectedId: id }, writeCaseUrl);
    if (id) void loadDetail(id);
  }

  const applySavedView = useCallback((view: SavedViewRecord) => {
    const next = caseQueryFromSavedState(view.queryState);
    setSelectedSavedViewId(view.id);
    setQuery(next);
    history.current.navigate({ query: next, selectedId, savedViewId: view.id }, writeCaseUrl);
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
      const next = { ...history.current.current().query, cursor: undefined };
      setQuery(next);
      history.current.replace({ query: next, selectedId, savedViewId: selectedSavedViewId }, writeCaseUrl);
      await Promise.all([loadList(next), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
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
        <div><p className="text-xs font-semibold tracking-[0.16em] text-[var(--ad-text-muted)]">{t("CUSTOMER OPERATIONS")}</p><h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em]" id="case-workspace-title">{t("Cases")}</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">{t("Evidence, decision, downstream verification, and closure stay attached to the customer problem.")}</p></div>
        {list ? <p className="text-xs text-[var(--ad-text-muted)]" role="status">{t(list.freshness)}  {t("· data as of")} <time dateTime={list.asOf}>{new Date(list.asOf).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US")}</time></p> : null}
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
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Search all cases")}<input className={fieldClass} onChange={(event) => updateDraft({ search: event.target.value })} placeholder={t("target or case key")} value={query.search} /></label>
        <Select label="Type" onChange={(type) => updateDraft({ type })} options={["", "content_report", "appeal", "support_request", "billing_dispute"]} value={query.type} />
        <Select label="Status" onChange={(status) => updateDraft({ status })} options={["", "new", "triaged", "in_progress", "waiting", "resolved", "closed", "reopened"]} value={query.status} />
        <Select label="Priority" onChange={(priority) => updateDraft({ priority })} options={["", "urgent", "high", "normal", "low"]} value={query.priority} />
        <Select label="Sort" onChange={(sort) => updateDraft({ sort: sort as CaseQueryDraft["sort"] })} options={["updated_desc", "updated_asc"]} value={query.sort} />
        <div className="flex items-end gap-2"><WorkspaceButton tone="primary" type="submit">{t("Apply")}</WorkspaceButton>{filtered ? <WorkspaceButton onClick={clearFilters}>{t("Clear")}</WorkspaceButton> : null}</div>
      </form>

      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</div> : null}
      {notice ? <div className="rounded-md bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]" role="status">{notice}</div> : null}

      {loading && !list ? <LoadingWorkspace label="Loading cases" /> : list && list.items.length === 0 ? <EmptyWorkspace filtered={filtered} onClear={clearFilters} /> : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(460px,1.08fr)]">
          <div className="space-y-2" aria-label={t("Case results")}>
            {list?.items.map((adminCase) => <CaseRow adminCase={adminCase} active={selectedId === adminCase.id} key={adminCase.id} onSelect={() => selectCase(adminCase.id)} referenceTime={list.asOf} />)}
            {list?.pageInfo.hasNextPage && list.pageInfo.endCursor ? <WorkspaceButton disabled={loading} onClick={() => { const next = { ...history.current.current().query, cursor: list.pageInfo.endCursor ?? undefined }; setQuery(next); history.current.navigate({ query: next, selectedId, savedViewId: selectedSavedViewId }, writeCaseUrl); void loadList(next); }}><RefreshCcw className="h-4 w-4" />{t("Next page")}</WorkspaceButton> : null}
          </div>
          {selectedId ? detailLoading && !detail ? <LoadingWorkspace label="Loading case detail" /> : detail ? <CaseInspector busy={busy} canAssign={canAssign} canDecide={canDecide} detail={detail} key={detail.case.id} onClose={() => selectCase(null)} onMutate={mutate} /> : null : <aside className="hidden rounded-xl bg-[var(--ad-surface-subtle)] p-8 text-sm text-[var(--ad-text-muted)] xl:block">{t("Select a case to inspect evidence and complete the decision loop.")}</aside>}
        </div>
      )}
    </section>
  );
}

function CaseTabs({ active, onChange }: { active: string; onChange: (view: string) => void }) {
  const { t } = useAdminI18n();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + direction + caseViews.length) % caseViews.length;
    refs.current[next]?.focus();
    onChange(caseViews[next]);
  }
  return <div aria-label={t("Case queue views")} className="flex gap-1 overflow-x-auto rounded-lg bg-[var(--ad-surface-subtle)] p-1" role="group">{caseViews.map((view, index) => <button aria-pressed={active === view} className={`min-h-11 shrink-0 rounded-md px-3 text-sm font-semibold transition ${active === view ? "bg-[var(--ad-surface)] text-[var(--ad-ink)] shadow-sm" : "text-[var(--ad-text-muted)] hover:text-[var(--ad-ink)]"}`} key={view} onClick={() => onChange(view)} onKeyDown={(event) => onKeyDown(event, index)} ref={(node) => { refs.current[index] = node; }} type="button">{t(view.replaceAll("_", " "))}</button>)}</div>;
}

function CaseRow({ active, adminCase, onSelect, referenceTime }: { active: boolean; adminCase: OperationsCase; onSelect: () => void; referenceTime: string }) {
  const { t } = useAdminI18n();
  const overdue = new Date(adminCase.slaDueAt).getTime() < new Date(referenceTime).getTime() && !["resolved", "closed"].includes(adminCase.status);
  return <button aria-current={active ? "true" : undefined} className="group w-full rounded-lg bg-[var(--ad-surface)] p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--ad-shadow-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]" onClick={onSelect} type="button"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--ad-text-muted)]">{t(adminCase.type.replaceAll("_", " "))} · {t(adminCase.target.type)}</p><p className="mt-1 truncate font-mono text-sm font-semibold">{adminCase.target.id}</p></div><ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ad-text-muted)] transition group-hover:translate-x-0.5" /></div><div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={adminCase.priority} /><StatusBadge value={adminCase.status} />{overdue ? <StatusBadge tone="bad" value="overdue" /> : null}</div><dl className="mt-4 grid grid-cols-3 gap-3"><Stat label="Evidence" value={adminCase.reportCount + adminCase.messageCount} /><Stat label="Owner" value={adminCase.ownerId ?? "unassigned"} /><Stat label="SLA" value={<RelativeTime referenceTime={referenceTime} value={adminCase.slaDueAt} />} /></dl></button>;
}

function CaseInspector({ busy, canAssign, canDecide, detail, onClose, onMutate }: { busy: boolean; canAssign: boolean; canDecide: boolean; detail: CaseDetail; onClose: () => void; onMutate: (label: string, execute: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useAdminI18n();
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
  const [decisionIdempotencyKey, setDecisionIdempotencyKey] = useState(() => crypto.randomUUID());
  const [verificationIdempotencyKey, setVerificationIdempotencyKey] = useState(() => crypto.randomUUID());
  const [verificationOverrideIdempotencyKey, setVerificationOverrideIdempotencyKey] = useState(() => crypto.randomUUID());
  const refs = evidenceRefs.split(",").map((item) => item.trim()).filter(Boolean);
  const closeConfirmation = `${adminCase.id}:close`;
  const canClose = adminCase.status === "resolved" && ["passed", "overridden"].includes(adminCase.verification?.state ?? "");

  return <aside aria-labelledby="case-detail-title" className="rounded-xl bg-[var(--ad-surface)] shadow-[0_18px_50px_rgb(45_42_34/0.08)] xl:sticky xl:top-40"><header className="flex items-start justify-between gap-4 border-b border-[var(--ad-border)] p-5"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--ad-text-muted)]">{t(adminCase.type.replaceAll("_", " "))}</p><h3 className="mt-1 truncate font-mono text-lg font-semibold" id="case-detail-title">{adminCase.target.id}</h3><div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={adminCase.priority} /><StatusBadge value={adminCase.status} />{adminCase.verification ? <StatusBadge value={adminCase.verification.state} /> : null}</div></div><button aria-label={t("Close case detail")} className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]" onClick={onClose} type="button"><X className="h-4 w-4" /></button></header>
    <div className="space-y-5 p-5">
      <section aria-labelledby="case-summary-title"><h4 className="text-sm font-semibold" id="case-summary-title">{t("Summary")}</h4><dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Owner" value={adminCase.ownerId ?? "unassigned"} /><Stat label="SLA" value={<RelativeTime referenceTime={adminCase.updatedAt} value={adminCase.slaDueAt} />} /><Stat label="Version" value={adminCase.version} /><Stat label="Evidence" value={detail.evidence.length} /></dl>{adminCase.resolutionSummary ? <p className="mt-3 rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]">{adminCase.resolutionSummary}</p> : null}</section>

      {adminCase.relatedIncidentIds.length > 0 || adminCase.relatedCaseIds.length > 0 ? <nav aria-label={t("Related operational records")} className="rounded-md bg-[var(--ad-surface-subtle)] p-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t("Related records")}</h4><div className="mt-2 flex flex-wrap gap-2">{adminCase.relatedIncidentIds.map((id) => <Link className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs font-semibold hover:border-[var(--ad-ink)]" href={`/admin/ops/incidents/${encodeURIComponent(id)}`} key={id}>{t("Incident")} {id}</Link>)}{adminCase.relatedCaseIds.map((id) => <Link className="rounded border border-[var(--ad-border)] px-2 py-1 text-xs font-semibold hover:border-[var(--ad-ink)]" href={`/admin/cases?case=${encodeURIComponent(id)}`} key={id}>{t("Case")} {id}</Link>)}</div></nav> : null}

      <section aria-labelledby="case-evidence-title"><div className="flex items-center justify-between"><h4 className="text-sm font-semibold" id="case-evidence-title">{t("Evidence")}</h4><span className="text-xs text-[var(--ad-text-muted)]">{t("immutable sources")}</span></div><ol className="mt-3 space-y-2">{detail.evidence.map((item) => <li className="rounded-md bg-[var(--ad-surface-subtle)] p-3" key={item.id}><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs">{item.id}</span><span className="text-xs text-[var(--ad-text-muted)]"><RelativeTime referenceTime={adminCase.updatedAt} value={item.occurredAt} /></span></div><p className="mt-2 text-sm leading-6">{item.summary}</p><p className="mt-2 text-xs text-[var(--ad-text-muted)]">{item.evidenceType} · {item.access}</p></li>)}</ol></section>

      {canAssign ? <form className="space-y-3 border-t border-[var(--ad-border)] pt-5" onSubmit={(event) => { event.preventDefault(); void onMutate("Case assignment saved", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/assignment`, { method: "POST", body: { entityVersion: adminCase.version, ownerId: ownerId.trim() || null, priority, reason: reason.trim() } })); }}><h4 className="text-sm font-semibold">{t("Assignment")}</h4><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Owner ID")}<input className={fieldClass} onChange={(event) => setOwnerId(event.target.value)} value={ownerId} /></label><Select label="Priority" onChange={(value) => setPriority(value as OperationsCase["priority"])} options={["urgent", "high", "normal", "low"]} value={priority} /></div><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Audit reason")}<input className={fieldClass} onChange={(event) => setReason(event.target.value)} required value={reason} /></label><WorkspaceButton disabled={busy || reason.trim().length < 3} tone="primary" type="submit">{t("Save assignment")}</WorkspaceButton></form> : null}

      {canAssign || canDecide ? <section className="space-y-3 border-t border-[var(--ad-border)] pt-5"><h4 className="text-sm font-semibold">{t("Lifecycle")}</h4><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Resume after (optional)")}<input className={fieldClass} onChange={(event) => setResumeAt(event.target.value)} type="datetime-local" value={resumeAt} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Type lifecycle confirmation")}<input className={fieldClass} onChange={(event) => setLifecycleConfirmation(event.target.value)} value={lifecycleConfirmation} /></label><div className="flex flex-wrap gap-2">{canAssign && ["new", "triaged", "in_progress", "reopened"].includes(adminCase.status) ? <WorkspaceButton disabled={busy || reason.trim().length < 3 || lifecycleConfirmation !== `${adminCase.id}:wait`} onClick={() => void onMutate("Case moved to waiting", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/commands/wait`, { method: "POST", body: { entityVersion: adminCase.version, reason: reason.trim(), resumeAt: resumeAt ? new Date(resumeAt).toISOString() : undefined, confirmation: lifecycleConfirmation } }))}>{t("Wait for dependency")}</WorkspaceButton> : null}{canDecide && ["resolved", "closed"].includes(adminCase.status) ? <WorkspaceButton disabled={busy || reason.trim().length < 3 || lifecycleConfirmation !== `${adminCase.id}:reopen`} onClick={() => void onMutate("Case reopened or recurrence created", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/commands/reopen`, { method: "POST", body: { entityVersion: adminCase.version, reason: reason.trim(), confirmation: lifecycleConfirmation } }))}>{t("Reopen / create recurrence")}</WorkspaceButton> : null}</div><p className="text-xs text-[var(--ad-text-muted)]">{t("Expected:")} <code>{adminCase.id}:{["resolved", "closed"].includes(adminCase.status) ? t("reopen") : t("wait")}</code></p></section> : null}

      {canDecide ? <section className="space-y-4 border-t border-[var(--ad-border)] pt-5" aria-labelledby="case-decision-title"><h4 className="text-sm font-semibold" id="case-decision-title">{t("Decision and verification")}</h4><Select label={customerCase ? "Customer action" : "Decision"} onChange={setDecision} options={operationOptions} value={decision} />{customerCase ? <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Outcome reference")}<input className={fieldClass} onChange={(event) => setOutcomeRef(event.target.value)} placeholder={adminCase.type === "billing_dispute" ? "ledger:&lt;id&gt;, refund:&lt;id&gt;, or subscription:&lt;id&gt;:&lt;status&gt;" : "incident:&lt;id&gt; or an override-only operational reference"} value={outcomeRef} /></label> : null}<label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Resolution summary")}<textarea className={textAreaClass} onChange={(event) => setSummary(event.target.value)} value={summary} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Evidence IDs (comma separated)")}<input className={fieldClass} onChange={(event) => setEvidenceRefs(event.target.value)} value={evidenceRefs} /></label><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || !decision || !summary.trim() || refs.length === 0 || (customerCase && !outcomeRef.trim())} onClick={() => void onMutate(customerCase ? "Customer Case action recorded" : "Case decision recorded", async () => { const result = await adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/${customerCase ? "actions" : "decisions"}`, { method: "POST", idempotencyKey: decisionIdempotencyKey, body: customerCase ? { entityVersion: adminCase.version, action: decision, summary: summary.trim(), evidenceRefs: refs, outcomeRef: outcomeRef.trim() } : { entityVersion: adminCase.version, decision, summary: summary.trim(), evidenceRefs: refs } }); setDecisionIdempotencyKey(crypto.randomUUID()); return result; })}><ClipboardCheck className="h-4 w-4" />{customerCase ? t("Record action") : t("Record decision")}</WorkspaceButton><WorkspaceButton disabled={busy || !adminCase.resolutionSummary || refs.length === 0} onClick={() => void onMutate("Downstream outcome verified", async () => { const result = await adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/verification`, { method: "POST", idempotencyKey: verificationIdempotencyKey, body: { entityVersion: adminCase.version, state: "passed", evidenceRefs: refs } }); setVerificationIdempotencyKey(crypto.randomUUID()); return result; })}><CheckCircle2 className="h-4 w-4" />{t("Verify from authority")}</WorkspaceButton></div><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Override reason (only when automatic verification is unavailable)")}<textarea className={textAreaClass} onChange={(event) => setVerificationOverrideReason(event.target.value)} value={verificationOverrideReason} /></label><WorkspaceButton disabled={busy || !adminCase.resolutionSummary || refs.length === 0 || verificationOverrideReason.trim().length < 3} onClick={() => void onMutate("Case verification explicitly overridden", async () => { const result = await adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/verification`, { method: "POST", idempotencyKey: verificationOverrideIdempotencyKey, body: { entityVersion: adminCase.version, state: "overridden", evidenceRefs: refs, overrideReason: verificationOverrideReason.trim() } }); setVerificationOverrideIdempotencyKey(crypto.randomUUID()); return result; })}>{t("Override verification")}</WorkspaceButton>
        <div className="rounded-md bg-[var(--ad-surface-subtle)] p-3"><code className="block break-all text-xs">{closeConfirmation}</code><label className="mt-3 grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Type confirmation")}<input className={fieldClass} onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label><div className="mt-3"><WorkspaceButton disabled={busy || !canClose || confirmation !== closeConfirmation || reason.trim().length < 3} tone="danger" onClick={() => void onMutate("Case close command accepted", () => adminV2Request(`/api/v2/admin/cases/${encodeURIComponent(adminCase.id)}/commands/close`, { method: "POST", idempotencyKey: closeIdempotencyKey, body: { entityVersion: adminCase.version, reason: { code: "outcome_verified", summary: reason.trim() }, confirmation } }))}>{t("Close case")}</WorkspaceButton></div></div>
      </section> : <p className="rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">{t("Read access only. Decisions require")} <code>{t("case.decide")}</code>.</p>}
      <CollaborationPanel canWrite={canAssign} targetId={adminCase.id} targetType="case" targetVersion={adminCase.version} />
    </div></aside>;
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: readonly string[]; value: string }) { const { t } = useAdminI18n(); return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<select className={fieldClass} onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? t(option.replaceAll("_", " ")) : t("All")}</option>)}</select></label>; }
function Stat({ label, value }: { label: string; value: ReactNode }) { const { t } = useAdminI18n(); return <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t(label)}</dt><dd className="mt-1 truncate font-mono text-sm text-[var(--ad-ink)]" title={typeof value === "string" ? value : undefined}>{value}</dd></div>; }
// INVARIANT: server and first browser render must use the same state; location is restored after hydration.
function initialCaseWorkspaceState(initialCaseId: string | null): CaseWorkspaceUrlState {
  return { query: defaultCaseQuery, selectedId: initialCaseId, savedViewId: null };
}
function stateFromLocation(initialCaseId: string | null): CaseWorkspaceUrlState {
  const parsed = parseCaseWorkspaceParams(new URLSearchParams(window.location.search));
  return {
    ...parsed,
    selectedId: initialCaseId ?? parsed.selectedId ?? workspaceDetailId(window.location.pathname, "/admin/cases"),
  };
}
function writeCaseUrl(state: CaseWorkspaceUrlState, mode: "push" | "replace") { setWorkspaceUrl(buildCaseWorkspaceParams(state), { mode, pathname: caseWorkspacePath(state.selectedId) }); }
function message(error: unknown) { return error instanceof Error ? error.message : "Case operation failed"; }
