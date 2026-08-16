"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCcw, X } from "lucide-react";
import {
  incidentListResponseSchema,
  type AdminListResponse,
  type OpsIncident,
} from "@idream/shared/admin";
import { adminV2Request, setWorkspaceUrl } from "@/lib/admin-v2-api";
import { createWorkspaceHistoryController, observeWorkspacePopState, workspaceDetailId } from "@/lib/workspace-history";
import { CollaborationPanel } from "@/features/collaboration/CollaborationPanel";
import { SavedViewsControl } from "@/features/collaboration/SavedViewsControl";
import {
  incidentQueryFromSavedState,
  incidentSavedState,
  type SavedViewRecord,
} from "@/features/collaboration/saved-views";
import {
  buildIncidentQuery,
  buildIncidentWorkspaceParams,
  defaultIncidentQuery,
  incidentWorkspacePath,
  parseIncidentWorkspaceParams,
  type IncidentQueryDraft,
  type IncidentWorkspaceUrlState,
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
import { IncidentCorrelationOutbox } from "./IncidentCorrelationOutbox";

type IncidentList = AdminListResponse<OpsIncident>;

type IncidentDetail = {
  incident: OpsIncident;
  occurrences: Array<{
    id: string;
    requestId: string;
    attemptId: string | null;
    observedAt: string;
    assignmentHistory: Array<{ id: string; fromIncidentId: string; toIncidentId: string; action: string; reason: string; createdAt: string }>;
  }>;
  actionPlans: IncidentPlan[];
  postmortem: { id: string; summary: string; rootCause: string; contributingFactors: string[]; correctiveActions: string[]; evidenceRefs: string[]; createdById: string; createdAt: string } | null;
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

export function IncidentWorkspace({
  canDiscardAttemptMissingCorrelationOutbox = false,
  canManage,
  canReadCorrelationOutbox = false,
  canReplayCorrelationOutbox = false,
  initialIncidentId = null,
}: {
  canDiscardAttemptMissingCorrelationOutbox?: boolean;
  canManage: boolean;
  canReadCorrelationOutbox?: boolean;
  canReplayCorrelationOutbox?: boolean;
  initialIncidentId?: string | null;
}) {
  const { locale, t } = useAdminI18n();
  const [initialUrlState] = useState(() => stateFromLocation(initialIncidentId));
  const [query, setQuery] = useState<IncidentQueryDraft>(initialUrlState.query);
  const [list, setList] = useState<IncidentList | null>(null);
  const [selectedId, setSelectedId] = useState(initialUrlState.selectedId);
  const [selectedSavedViewId, setSelectedSavedViewId] = useState(initialUrlState.savedViewId);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const firstQuery = useRef(query);
  const history = useRef(createWorkspaceHistoryController(initialUrlState));
  const listRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const loadList = useCallback(async (next: IncidentQueryDraft) => {
    const requestId = ++listRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const response = await adminV2Request<IncidentList>(
        `/api/v2/admin/incidents?${buildIncidentQuery(next)}`,
        { schema: incidentListResponseSchema },
      );
      if (requestId !== listRequestId.current) return;
      setList(response);
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
    const timer = window.setTimeout(() => {
      if (!initialIncidentId) history.current.replace(initialUrlState, writeIncidentUrl);
      void loadList(firstQuery.current);
      if (initialUrlState.selectedId) void loadDetail(initialUrlState.selectedId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialIncidentId, initialUrlState, loadDetail, loadList]);

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

  function updateDraft(patch: Partial<IncidentQueryDraft>) {
    const next = { ...query, ...patch, cursor: undefined };
    setQuery(next);
    history.current.draft({ ...history.current.current(), query: next }, writeIncidentUrl);
  }

  function applyFilters(event?: FormEvent) {
    event?.preventDefault();
    const next = { ...query, cursor: undefined };
    setSelectedSavedViewId(null);
    setQuery(next);
    history.current.navigate({ query: next, selectedId, savedViewId: null }, writeIncidentUrl);
    void loadList(next);
  }

  function clearFilters() {
    setSelectedSavedViewId(null);
    setQuery(defaultIncidentQuery);
    history.current.navigate({ query: defaultIncidentQuery, selectedId, savedViewId: null }, writeIncidentUrl);
    void loadList(defaultIncidentQuery);
  }

  function selectIncident(id: string | null) {
    detailRequestId.current += 1;
    setSelectedId(id);
    setDetail(null);
    history.current.navigate({ ...history.current.current(), selectedId: id }, writeIncidentUrl);
    if (id) void loadDetail(id);
  }

  const applySavedView = useCallback((view: SavedViewRecord) => {
    const next = incidentQueryFromSavedState(view.queryState);
    setSelectedSavedViewId(view.id);
    setQuery(next);
    history.current.navigate({ query: next, selectedId, savedViewId: view.id }, writeIncidentUrl);
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
      history.current.replace({ query: next, selectedId, savedViewId: selectedSavedViewId }, writeIncidentUrl);
      await Promise.all([loadList(next), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
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
          <h2 className="sr-only" id="incident-workspace-title">{t("Incidents")}</h2>
          <p className="max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">

            {t("Correlated failures, frozen mitigation scope, and recovery evidence in one operational root.")}
          </p>
        </div>
        {list ? (
          <p className="text-xs text-[var(--ad-text-muted)]" role="status">
            {t(list.freshness)}  {t("· data as of")} <time dateTime={list.asOf}>{new Date(list.asOf).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US")}</time>
          </p>
        ) : null}
      </header>

      <SavedViewsControl
        currentState={incidentSavedState(query)}
        onApply={applySavedView}
        onSelectedChange={selectSavedView}
        scope="incident"
        selectedId={selectedSavedViewId}
      />

      <form className="grid gap-3 rounded-xl bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(240px,1fr)_repeat(3,180px)_auto]" onSubmit={applyFilters}>
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Search all incidents")}
          <input className={fieldClass} onChange={(event) => updateDraft({ search: event.target.value })} placeholder={t("signature or suspected cause")} value={query.search} />
        </label>
        <Select label="Status" onChange={(status) => updateDraft({ status })} options={["", "detected", "triaged", "mitigating", "monitoring", "resolved", "closed"]} value={query.status} />
        <Select label="Severity" onChange={(severity) => updateDraft({ severity })} options={["", "critical", "high", "medium", "low"]} value={query.severity} />
        <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">

          {t("Owner ID")}
          <input className={fieldClass} onChange={(event) => updateDraft({ ownerId: event.target.value })} value={query.ownerId} />
        </label>
        <div className="flex items-end gap-2"><WorkspaceButton tone="primary" type="submit">{t("Apply")}</WorkspaceButton>{filtered ? <WorkspaceButton onClick={clearFilters}>{t("Clear")}</WorkspaceButton> : null}</div>
      </form>

      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</div> : null}
      {notice ? <div className="rounded-md bg-[var(--ad-green-bg)] px-4 py-3 text-sm text-[var(--ad-green-text)]" role="status">{notice}</div> : null}

      {loading && !list ? <LoadingWorkspace label="Loading correlated incidents" /> : list && list.items.length === 0 ? (
        <EmptyWorkspace filtered={filtered} onClear={clearFilters} />
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.92fr)_minmax(440px,1.08fr)]">
          <div className="space-y-2" aria-label={t("Incident results")}>
            {list?.items.map((incident) => (
              <button
                aria-current={selectedId === incident.id ? "true" : undefined}
                className="group w-full rounded-lg bg-[var(--ad-surface)] p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[var(--ad-shadow-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
                key={incident.id}
                onClick={() => selectIncident(incident.id)}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="truncate font-mono text-xs text-[var(--ad-text-muted)]">{incident.signature.slice(0, 18)}</p><p className="mt-1 line-clamp-2 text-sm font-semibold">{incident.suspectedCause ?? t("Cause not yet established")}</p></div>
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--ad-text-muted)] transition group-hover:translate-x-0.5" />
                </div>
                <div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={incident.severity} /><StatusBadge value={incident.status} /><StatusBadge value={incident.recoveryVerification.state} /></div>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-xs"><Stat label="Requests" value={incident.impact.affectedRequests} /><Stat label="Users" value={incident.impact.affectedUsers} /><Stat label="Last seen" value={<RelativeTime referenceTime={list.asOf} value={incident.lastSeenAt} />} /></dl>
              </button>
            ))}
            {list?.pageInfo.hasNextPage && list.pageInfo.endCursor ? (
              <WorkspaceButton disabled={loading} onClick={() => { const next = { ...history.current.current().query, cursor: list.pageInfo.endCursor ?? undefined }; setQuery(next); history.current.navigate({ query: next, selectedId, savedViewId: selectedSavedViewId }, writeIncidentUrl); void loadList(next); }}><RefreshCcw className="h-4 w-4" />{t("Next page")}</WorkspaceButton>
            ) : null}
          </div>

          {selectedId ? (
            detailLoading && !detail ? <LoadingWorkspace label="Loading incident detail" /> : detail ? (
              <IncidentInspector busy={busy} canManage={canManage} detail={detail} key={detail.incident.id} onClose={() => selectIncident(null)} onMutate={mutate} />
            ) : null
          ) : (
            <aside className="hidden rounded-xl bg-[var(--ad-surface-subtle)] p-8 text-sm text-[var(--ad-text-muted)] xl:block">{t("Select an incident to inspect occurrences, mitigation scope, and recovery evidence.")}</aside>
          )}
        </div>
      )}

      {/* SPEC: 事故队列先，投递管道修复在后。
          INTENT: 这块曾占着页面第一屏，把真正的事故列表挤到折叠线以下——它是"关联事件没投递
          成功时才用"的恢复工具，不是每天要读的东西。 */}
      <IncidentCorrelationOutbox
        canDiscardAttemptMissing={canDiscardAttemptMissingCorrelationOutbox}
        canRead={canReadCorrelationOutbox}
        canReplay={canReplayCorrelationOutbox}
      />
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
  const { t } = useAdminI18n();
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
  const [verificationIdempotencyKey, setVerificationIdempotencyKey] = useState(() => crypto.randomUUID());
  const [verificationOverrideIdempotencyKey, setVerificationOverrideIdempotencyKey] = useState(() => crypto.randomUUID());
  const [closeIdempotencyKey] = useState(() => crypto.randomUUID());
  const [confirmation, setConfirmation] = useState("");
  const [evidence, setEvidence] = useState("");
  const [verificationOverrideReason, setVerificationOverrideReason] = useState("");
  const [selectedOccurrenceIds, setSelectedOccurrenceIds] = useState<string[]>([]);
  const [mergeSources, setMergeSources] = useState("");
  const [postmortemSummary, setPostmortemSummary] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [contributingFactors, setContributingFactors] = useState("");
  const [correctiveActions, setCorrectiveActions] = useState("");
  const [closeConfirmation, setCloseConfirmation] = useState("");

  const expectedPlanConfirmation = plan ? `${incident.id}:${plan.id}:${plan.action}` : "";
  const canVerify = ["mitigating", "monitoring"].includes(incident.status);
  const canResolve = incident.status === "monitoring" && ["passed", "overridden"].includes(incident.recoveryVerification.state);
  const splitIds = [...selectedOccurrenceIds].sort();
  const splitConfirmation = `${incident.id}:split:${splitIds.join(",")}`;
  const mergeSourceRecords = mergeSources.split(",").map((item) => item.trim()).filter(Boolean).flatMap((item) => {
    const [incidentId, version] = item.split("@");
    const parsedVersion = Number(version);
    return incidentId && Number.isInteger(parsedVersion) && parsedVersion > 0 ? [{ incidentId, version: parsedVersion }] : [];
  });
  const mergeSourceIds = [...new Set(mergeSourceRecords.map((source) => source.incidentId).filter((id) => id !== incident.id))].sort();
  const mergeConfirmation = `${incident.id}:merge:${mergeSourceIds.join(",")}`;

  return (
    <aside aria-labelledby="incident-detail-title" className="rounded-xl bg-[var(--ad-surface)] shadow-[0_18px_50px_rgb(45_42_34/0.08)] xl:sticky xl:top-40">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--ad-border)] p-5">
        <div className="min-w-0"><p className="font-mono text-xs text-[var(--ad-text-muted)]">{incident.id}</p><h3 className="mt-1 text-lg font-semibold" id="incident-detail-title">{incident.suspectedCause ?? t("Incident under investigation")}</h3><div className="mt-3 flex flex-wrap gap-2"><StatusBadge value={incident.severity} /><StatusBadge value={incident.status} /></div></div>
        <button aria-label={t("Close incident detail")} className="grid min-h-11 min-w-11 place-items-center rounded-md hover:bg-black/[0.04]" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
      </header>

      <div className="space-y-5 p-5">
        <section aria-labelledby="incident-impact-title"><h4 className="text-sm font-semibold" id="incident-impact-title">{t("Impact and recovery")}</h4><dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Requests" value={incident.impact.affectedRequests} /><Stat label="Users" value={incident.impact.affectedUsers} /><Stat label="Occurrences" value={detail.occurrences.length} /><Stat label="Verification" value={incident.recoveryVerification.state} /></dl></section>

        <details className="rounded-lg bg-[var(--ad-surface-subtle)] p-4" open><summary className="cursor-pointer text-sm font-semibold">{t("Occurrences (")}{detail.occurrences.length})</summary><ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">{detail.occurrences.map((occurrence) => <li className="flex items-center justify-between gap-3 border-b border-[var(--ad-border)] pb-2 text-xs last:border-0" key={occurrence.id}>{canManage ? <input aria-label={t("Select occurrence {id}", { id: occurrence.id })} checked={selectedOccurrenceIds.includes(occurrence.id)} onChange={(event) => setSelectedOccurrenceIds((current) => event.target.checked ? [...current, occurrence.id] : current.filter((id) => id !== occurrence.id))} type="checkbox" /> : null}<span className="min-w-0 flex-1 truncate font-mono">{occurrence.requestId}{occurrence.assignmentHistory.length > 0 ? t("· reassigned {count}×", { count: occurrence.assignmentHistory.length }) : ""}</span><RelativeTime referenceTime={incident.updatedAt} value={occurrence.observedAt} /></li>)}</ul></details>

        {canManage ? (
          <>
            <form className="space-y-3 border-t border-[var(--ad-border)] pt-5" onSubmit={(event) => { event.preventDefault(); void onMutate("Incident triage saved", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}`, { method: "PATCH", body: { entityVersion: incident.version, ownerId: ownerId.trim() || null, severity, suspectedCause: cause.trim() || undefined, reason: reason.trim() } })); }}>
              <h4 className="text-sm font-semibold">{t("Triage")}</h4>
              <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Owner ID")}<input className={fieldClass} onChange={(event) => setOwnerId(event.target.value)} value={ownerId} /></label><Select label="Severity" onChange={(value) => setSeverity(value as OpsIncident["severity"])} options={["critical", "high", "medium", "low"]} value={severity} /></div>
              <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Suspected cause")}<textarea className={textAreaClass} onChange={(event) => setCause(event.target.value)} value={cause} /></label>
              <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Audit reason")}<input className={fieldClass} onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
              <WorkspaceButton disabled={busy || reason.trim().length < 3} tone="primary" type="submit">{t("Save triage")}</WorkspaceButton>
            </form>

            <section className="space-y-3 border-t border-[var(--ad-border)] pt-5" aria-labelledby="mitigation-plan-title"><h4 className="text-sm font-semibold" id="mitigation-plan-title">{t("Mitigation plan")}</h4><div className="grid gap-3 sm:grid-cols-2"><Select label="Action" onChange={(value) => { setAction(value as IncidentPlan["action"]); setPlan(null); }} options={["retry_eligible", "refund", "pause_route", "rollback"]} value={action} /><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Rollback target")}<input className={fieldClass} disabled={action !== "rollback"} onChange={(event) => setTargetVersion(event.target.value)} value={targetVersion} /></label></div>
              <WorkspaceButton disabled={busy || (action === "rollback" && !targetVersion.trim())} onClick={() => void onMutate("Frozen mitigation preview created", async () => { const next = await adminV2Request<IncidentPlan>(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/action-plans/preview`, { method: "POST", body: { action, targetVersion: action === "rollback" ? targetVersion : undefined } }); setPlan(next); setPlanIdempotencyKey(crypto.randomUUID()); })}>{t("Preview eligible scope")}</WorkspaceButton>
              {plan ? <div className="rounded-md bg-[var(--ad-yellow-bg)] p-3 text-sm"><p><strong>{plan.eligibleIds?.length ?? plan.eligibleOccurrenceIds?.length ?? 0}</strong>  {t("eligible ·")} <strong>{plan.skippedIds?.length ?? plan.skippedOccurrenceIds?.length ?? 0}</strong>  {t("skipped")}</p><code className="mt-2 block break-all text-xs">{expectedPlanConfirmation}</code><label className="mt-3 grid gap-1 text-xs font-semibold">{t("Type confirmation")}<input className={fieldClass} onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label><div className="mt-3"><WorkspaceButton disabled={busy || confirmation !== expectedPlanConfirmation} tone="danger" onClick={() => void onMutate("Mitigation plan executed", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/action-plans/${encodeURIComponent(plan.id)}/execute`, { method: "POST", idempotencyKey: planIdempotencyKey, body: { entityVersion: incident.version, confirmation } }))}>{t("Execute frozen plan")}</WorkspaceButton></div></div> : null}
            </section>

            <section className="space-y-3 border-t border-[var(--ad-border)] pt-5" aria-labelledby="incident-correlation-title"><h4 className="text-sm font-semibold" id="incident-correlation-title">{t("Correlation corrections")}</h4><p className="text-xs text-[var(--ad-text-muted)]">{t("Split preserves an immutable assignment history. Merge sources use")} <code>{t("incidentId@version")}</code>{t(", comma separated.")}</p><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Merge sources")}<input className={fieldClass} onChange={(event) => setMergeSources(event.target.value)} value={mergeSources} /></label><div className="flex flex-wrap gap-2"><WorkspaceButton disabled={busy || splitIds.length === 0 || splitIds.length >= detail.occurrences.length || confirmation !== splitConfirmation || reason.trim().length < 3} onClick={() => void onMutate("Selected occurrences split into a new Incident", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/commands/split`, { method: "POST", body: { entityVersion: incident.version, occurrenceIds: splitIds, reason: reason.trim(), confirmation } }))}>{t("Split selected")}</WorkspaceButton><WorkspaceButton disabled={busy || mergeSourceIds.length === 0 || confirmation !== mergeConfirmation || reason.trim().length < 3} onClick={() => void onMutate("Incidents merged with assignment history", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/commands/merge`, { method: "POST", body: { entityVersion: incident.version, sources: mergeSourceRecords, reason: reason.trim(), confirmation } }))}>{t("Merge sources")}</WorkspaceButton></div><code className="block break-all text-xs">{splitIds.length > 0 ? splitConfirmation : mergeConfirmation}</code></section>

            <section
              aria-labelledby="incident-verification-title"
              className="space-y-3 border-t border-[var(--ad-border)] pt-5"
            >
              <h4 className="text-sm font-semibold" id="incident-verification-title">{t("Recovery verification")}</h4>
              <p className="text-xs leading-5 text-[var(--ad-text-muted)]">

                {t("Pass/fail is derived by main from route outcomes, signature growth, affected-request backlog, completed mitigation scope, and Dreamcoin ledger authority. Operator input cannot make these checks pass.")}
              </p>
              <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">

                {t("Supplemental evidence reference (optional for authority check)")}
                <input
                  className={fieldClass}
                  onChange={(event) => setEvidence(event.target.value)}
                  placeholder={t("monitor, dashboard, or runbook reference")}
                  value={evidence}
                />
              </label>
              <div className="grid gap-2 rounded-md bg-[var(--ad-surface-subtle)] p-3" aria-label={t("Authority-derived recovery checks")}>
                <p className="text-xs font-semibold">{t("Authority-derived checks")}</p>
                {([
                  ["successRateRecovered", "Success rate recovered for the required window"],
                  ["signatureGrowthStopped", "Failure signature stopped growing"],
                  ["backlogRecovering", "Backlog is recovering"],
                  ["failedRequestPlanComplete", "Every failed request has a retry or terminal plan"],
                  ["settlementReconciled", "Spend and refunds are reconciled"],
                ] as const).map(([key, label]) => (
                  <div className="rounded border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3 text-xs" key={key}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{label}</span>
                      <StatusBadge value={incident.recoveryVerification.checks?.[key].passed ? "passed" : incident.recoveryVerification.checks ? "failed" : "not checked"} />
                    </div>
                    {incident.recoveryVerification.checks?.[key] ? <p className="mt-2 text-[var(--ad-text-muted)]">{incident.recoveryVerification.checks[key].summary}</p> : null}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <WorkspaceButton
                  disabled={busy || !canVerify}
                  onClick={() => void onMutate(
                    "Authority recovery verification evaluated",
                    async () => {
                      const result = await adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/verification`, {
                        method: "POST",
                        idempotencyKey: verificationIdempotencyKey,
                        body: {
                          entityVersion: incident.version,
                          mode: "derive",
                          evidenceRefs: evidence.trim() ? [evidence.trim()] : [],
                        },
                      });
                      setVerificationIdempotencyKey(crypto.randomUUID());
                      return result;
                    },
                  )}
                >
                  <CheckCircle2 className="h-4 w-4" />{t("Run authority verification")}
                </WorkspaceButton>
                <WorkspaceButton
                  disabled={busy || !canResolve || reason.trim().length < 3}
                  onClick={() => void onMutate(
                    "Incident resolve command accepted",
                    () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/commands/resolve`, {
                      method: "POST",
                      idempotencyKey: resolveIdempotencyKey,
                      body: {
                        entityVersion: incident.version,
                        reason: { code: "recovery_verified", summary: reason.trim() },
                        confirmation: `${incident.id}:resolve`,
                      },
                    }),
                  )}
                  tone="primary"
                >

                  {t("Resolve incident")}
                </WorkspaceButton>
              </div>
              <details className="rounded-md border border-[var(--ad-yellow-text)]/30 bg-[var(--ad-yellow-bg)] p-3">
                <summary className="cursor-pointer text-xs font-semibold">{t("Exceptional override")}</summary>
                <p className="mt-2 text-xs leading-5 text-[var(--ad-text-muted)]">{t("Override does not change any derived check. It requires durable evidence and an audited reason.")}</p>
                <label className="mt-3 grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Override reason")}<textarea className={textAreaClass} onChange={(event) => setVerificationOverrideReason(event.target.value)} value={verificationOverrideReason} /></label>
                <div className="mt-3"><WorkspaceButton disabled={busy || !canVerify || !evidence.trim() || verificationOverrideReason.trim().length < 10} tone="danger" onClick={() => void onMutate("Recovery verification explicitly overridden", async () => { const result = await adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/verification`, { method: "POST", idempotencyKey: verificationOverrideIdempotencyKey, body: { entityVersion: incident.version, mode: "override", evidenceRefs: [evidence.trim()], overrideReason: verificationOverrideReason.trim() } }); setVerificationOverrideIdempotencyKey(crypto.randomUUID()); return result; })}>{t("Override with audit")}</WorkspaceButton></div>
              </details>
              {!canVerify ? (
                <p className="text-xs text-[var(--ad-yellow-text)]">
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />{t("Execute mitigation before verification.")}
                </p>
              ) : null}
            </section>
            {incident.status === "resolved" ? <section className="space-y-3 border-t border-[var(--ad-border)] pt-5" aria-labelledby="incident-postmortem-title"><h4 className="text-sm font-semibold" id="incident-postmortem-title">{t("Postmortem and close")}</h4><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Summary")}<textarea className={textAreaClass} onChange={(event) => setPostmortemSummary(event.target.value)} value={postmortemSummary} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Root cause")}<textarea className={textAreaClass} onChange={(event) => setRootCause(event.target.value)} value={rootCause} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Contributing factors (one per line)")}<textarea className={textAreaClass} onChange={(event) => setContributingFactors(event.target.value)} value={contributingFactors} /></label><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Corrective actions (one per line)")}<textarea className={textAreaClass} onChange={(event) => setCorrectiveActions(event.target.value)} value={correctiveActions} /></label><code className="block text-xs">{incident.id}{t(":close")}</code><label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t("Type close confirmation")}<input className={fieldClass} onChange={(event) => setCloseConfirmation(event.target.value)} value={closeConfirmation} /></label><WorkspaceButton disabled={busy || postmortemSummary.trim().length < 10 || rootCause.trim().length < 3 || !correctiveActions.trim() || !evidence.trim() || closeConfirmation !== `${incident.id}:close` || reason.trim().length < 3} onClick={() => void onMutate("Postmortem recorded and Incident closed", () => adminV2Request(`/api/v2/admin/incidents/${encodeURIComponent(incident.id)}/commands/close`, { method: "POST", idempotencyKey: closeIdempotencyKey, body: { entityVersion: incident.version, summary: postmortemSummary.trim(), rootCause: rootCause.trim(), contributingFactors: contributingFactors.split("\n").map((item) => item.trim()).filter(Boolean), correctiveActions: correctiveActions.split("\n").map((item) => item.trim()).filter(Boolean), evidenceRefs: [evidence.trim()], reason: reason.trim(), confirmation: closeConfirmation } }))} tone="primary">{t("Record postmortem and close")}</WorkspaceButton></section> : null}
          </>
        ) : <p className="rounded-md bg-[var(--ad-surface-subtle)] p-3 text-sm text-[var(--ad-text-muted)]">{t("Read access only. Incident actions require")} <code>{t("ops.incident.manage")}</code>.</p>}
        <CollaborationPanel canWrite={canManage} targetId={incident.id} targetType="incident" targetVersion={incident.version} />
      </div>
    </aside>
  );
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string }) {
  const { t } = useAdminI18n();
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<select className={fieldClass} onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? t(option.replaceAll("_", " ")) : t("All")}</option>)}</select></label>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  const { t } = useAdminI18n();
  return <div><dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ad-text-muted)]">{t(label)}</dt><dd className="mt-1 font-mono text-sm text-[var(--ad-ink)]">{value}</dd></div>;
}

function stateFromLocation(initialIncidentId: string | null) { const parsed = typeof window === "undefined" ? { query: defaultIncidentQuery, selectedId: null, savedViewId: null } : parseIncidentWorkspaceParams(new URLSearchParams(window.location.search)); return { ...parsed, selectedId: initialIncidentId ?? parsed.selectedId ?? (typeof window === "undefined" ? null : workspaceDetailId(window.location.pathname, "/admin/ops/incidents")) }; }

function writeIncidentUrl(state: IncidentWorkspaceUrlState, mode: "push" | "replace") { setWorkspaceUrl(buildIncidentWorkspaceParams(state), { mode, pathname: incidentWorkspacePath(state.selectedId) }); }

function message(error: unknown) {
  return error instanceof Error ? error.message : "Incident operation failed";
}
