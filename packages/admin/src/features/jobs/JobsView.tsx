"use client";

import { FileText, Loader2, RefreshCcw, X } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  generationJobDetailResponseSchema,
  generationJobListResponseSchema,
  retryGenerationRequestResultSchema,
  type GenerationJobDetailResponse,
  type GenerationJobListResponse,
} from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { adminV2Request } from "@/lib/admin-v2-api";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  adminDateLocale,
  type AdminLocale,
  useAdminI18n,
} from "@/components/admin/i18n";
import { FailureReason } from "@/components/admin/generation/FailureReason";
import {
  ReadonlyOpsView,
  type OpsColumn,
} from "@/components/admin/generation/ReadonlyOpsView";
import {
  buildGenerationJobQuery,
  defaultGenerationJobQuery,
  GENERATION_JOBS_REFRESH_EVENT,
  generationJobStatusOptions,
  parseGenerationJobQuery,
  type GenerationJobQueryDraft,
} from "./query";
import { UnknownGenerationReconciliationControls } from "./UnknownGenerationReconciliationControls";

type Row = Record<string, unknown>;

type HistoryMode = "push" | "replace";

export function JobsView() {
  const { locale, t, value } = useAdminI18n();
  const [jobQuery, setJobQuery] = useState<GenerationJobQueryDraft>(defaultGenerationJobQuery);
  const [jobs, setJobs] = useState(() => createAuthorityState<GenerationJobListResponse>());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GenerationJobDetailResponse | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retrySpec, setRetrySpec] = useState<ConfirmSpec | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const jobsGate = useRef(createLatestRequestGate());

  const loadJobs = useCallback(async (next: GenerationJobQueryDraft) => {
    const encoded = buildGenerationJobQuery(next);
    const request = jobsGate.current.begin();
    setJobs((current) => authorityRequestStarted(current, encoded));
    try {
      const data = generationJobListResponseSchema.parse(
        await apiGet<unknown>(`/api/v2/admin/jobs?${encoded}`),
      );
      if (!request.isCurrent()) return;
      setJobs(authorityRequestSucceeded(encoded, data));
    } catch (cause) {
      if (!request.isCurrent()) return;
      setJobs((current) => authorityRequestFailed(
        current,
        encoded,
        cause instanceof Error ? cause.message : "Generation Jobs could not be loaded",
      ));
    }
  }, []);

  const loadJobDetail = useCallback(async (id: string) => {
    setSelectedJobId(id);
    setDetail(null);
    setDetailError(null);
    setDetailBusy(true);
    try {
      setDetail(generationJobDetailResponseSchema.parse(
        await apiGet<unknown>(`/api/v2/admin/jobs/${encodeURIComponent(id)}`),
      ));
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : t("Job detail load failed"));
    } finally {
      setDetailBusy(false);
    }
  }, [t]);

  const writeUrl = useCallback((next: GenerationJobQueryDraft, mode: HistoryMode, jobId?: string | null) => {
    const params = new URLSearchParams(buildGenerationJobQuery(next));
    if (jobId) params.set("job", jobId);
    const href = `${window.location.pathname}?${params.toString()}`;
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", href);
  }, []);

  useEffect(() => {
    const gate = jobsGate.current;
    const params = new URLSearchParams(window.location.search);
    const initial = parseGenerationJobQuery(params);
    const initialJobId = params.get("job")?.trim() || null;
    const timer = window.setTimeout(() => {
      setJobQuery(initial);
      writeUrl(initial, "replace", initialJobId);
      void loadJobs(initial);
      if (initialJobId) void loadJobDetail(initialJobId);
    }, 0);
    return () => {
      gate.invalidate();
      window.clearTimeout(timer);
    };
  }, [loadJobDetail, loadJobs, writeUrl]);

  useEffect(() => {
    const refresh = () => {
      const current = parseGenerationJobQuery(new URLSearchParams(window.location.search));
      setJobQuery(current);
      void loadJobs(current);
    };
    const restoreFromHistory = () => {
      const params = new URLSearchParams(window.location.search);
      const current = parseGenerationJobQuery(params);
      const jobId = params.get("job")?.trim() || null;
      setJobQuery(current);
      void loadJobs(current);
      if (jobId) void loadJobDetail(jobId);
      else {
        setSelectedJobId(null);
        setDetail(null);
        setDetailError(null);
      }
    };
    window.addEventListener(GENERATION_JOBS_REFRESH_EVENT, refresh);
    window.addEventListener("popstate", restoreFromHistory);
    return () => {
      window.removeEventListener(GENERATION_JOBS_REFRESH_EVENT, refresh);
      window.removeEventListener("popstate", restoreFromHistory);
    };
  }, [loadJobDetail, loadJobs]);

  function updateJobQuery(patch: Partial<GenerationJobQueryDraft>) {
    setJobQuery((current) => ({ ...current, ...patch, cursor: undefined }));
  }

  function applyJobQuery(next: GenerationJobQueryDraft = { ...jobQuery, cursor: undefined }) {
    setJobQuery(next);
    setSelectedJobId(null);
    setDetail(null);
    setDetailError(null);
    writeUrl(next, "push");
    void loadJobs(next);
  }

  function openJobDetail(id: string, trigger: HTMLButtonElement) {
    if (!id) return;
    detailTriggerRef.current = trigger;
    writeUrl(jobQuery, "push", id);
    void loadJobDetail(id);
  }

  function closeJobDetail() {
    setSelectedJobId(null);
    setDetail(null);
    setDetailError(null);
    writeUrl(jobQuery, "replace");
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
  }

  const columns: OpsColumn[] = [
    {
      key: "userId",
      label: "User",
      render: (row) => <span className="font-mono text-xs">{shortId(stringValue(row.userId))}</span>,
    },
    {
      key: "createdAt",
      label: "Created",
      render: (row) => compactDate(stringValue(row.createdAt), locale),
    },
    { key: "requestOutcome", label: "Request outcome", render: (row) => value(stringValue(row.requestOutcome)) },
    {
      key: "unknownReview",
      label: "Unknown review",
      render: (row) => {
        const review = row.unknownReview as Row | undefined;
        const status = stringValue(review?.status);
        const nextReviewAt = stringValue(review?.nextReviewAt);
        if (!status || status === "not_applicable") {
          return <span className="text-[var(--ad-text-muted)]">—</span>;
        }
        return (
          <span className={status === "due" ? "font-semibold text-red-700" : "text-amber-700"}>
            {t(status)}{nextReviewAt ? ` · ${compactDate(nextReviewAt, locale)}` : ""}
          </span>
        );
      },
    },
    { key: "settlement", label: "Settlement", render: (row) => value(stringValue((row.settlement as Row | undefined)?.view)) },
    {
      key: "failure",
      label: "Failure reason",
      render: (row) => stringValue(row.requestOutcome) === "failed"
        ? <FailureReason code={stringValue(row.errorCode)} />
        : <span className="text-[var(--ad-text-muted)]">—</span>,
    },
    {
      key: "actions",
      label: "Actions",
      render: (row) => {
        const id = stringValue(row.id);
        return (
          <div className="flex flex-wrap gap-1">
            <IconAction
              icon={<FileText className="h-4 w-4" />}
              label="Details"
              onClick={(event) => void openJobDetail(id, event.currentTarget)}
            />
            {stringValue(row.requestOutcome) === "failed" ? (
              <IconAction
                icon={<RefreshCcw className="h-4 w-4" />}
                label="Retry"
                onClick={() => setRetrySpec({
                  title: `Retry Generation Request ${shortId(id)}`,
                  summary: "Creates a new immutable Attempt only when no delivery has already succeeded.",
                  destructive: { expectedName: `${id}:retry` },
                  submitLabel: "Create retry attempt",
                  onSubmit: async (reason) => {
                    await adminV2Request(`/api/v2/admin/jobs/${encodeURIComponent(id)}/commands/retry`, {
                      method: "POST",
                      idempotencyKey: crypto.randomUUID(),
                      body: {
                        entityVersion: numberValue(row.version),
                        reason,
                        confirmation: `${id}:retry`,
                      },
                      schema: retryGenerationRequestResultSchema,
                    });
                    await loadJobs(jobQuery);
                  },
                })}
              />
            ) : null}
          </div>
        );
      },
    },
  ];
  const rows: Row[] = jobs.data?.items.map((item) => ({ ...item })) ?? [];
  const fieldClass = "h-10 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm outline-none focus:border-[var(--ad-ink)]";

  return (
    <div className="space-y-4">
      <form
        className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          applyJobQuery();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs font-semibold text-[var(--ad-text-muted)] sm:col-span-2">{t("Search authoritative fields")}<input className={`${fieldClass} mt-1`} onChange={(event) => updateJobQuery({ search: event.target.value })} placeholder={t("Job, user, character, model, error…")} value={jobQuery.search} /></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Mode")}<select className={`${fieldClass} mt-1`} onChange={(event) => updateJobQuery({ mode: event.target.value as GenerationJobQueryDraft["mode"] })} value={jobQuery.mode}><option value="all">{t("All historical records")}</option><option value="image">{t("Image")}</option><option value="video">{t("Video")}</option></select></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Legacy status filter")}<select className={`${fieldClass} mt-1`} onChange={(event) => updateJobQuery({ legacyStatus: event.target.value })} value={jobQuery.legacyStatus}><option value="">{t("All")}</option>{generationJobStatusOptions.map((status) => <option key={status} value={status}>{value(status)}</option>)}</select></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Provider")}<input className={`${fieldClass} mt-1`} list="job-provider-facets" onChange={(event) => updateJobQuery({ provider: event.target.value })} value={jobQuery.provider} /></label>
          <datalist id="job-provider-facets">{jobs.data?.facets.providers.map((facet) => <option key={facet.value} value={facet.value}>{facet.count}</option>)}</datalist>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Source type")}<input className={`${fieldClass} mt-1`} list="job-source-facets" onChange={(event) => updateJobQuery({ sourceType: event.target.value })} value={jobQuery.sourceType} /></label>
          <datalist id="job-source-facets">{jobs.data?.facets.sourceTypes.map((facet) => <option key={facet.value} value={facet.value}>{facet.count}</option>)}</datalist>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("User ID")}<input className={`${fieldClass} mt-1`} onChange={(event) => updateJobQuery({ userId: event.target.value })} value={jobQuery.userId} /></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Character ID")}<input className={`${fieldClass} mt-1`} onChange={(event) => updateJobQuery({ characterId: event.target.value })} value={jobQuery.characterId} /></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Sort")}<select className={`${fieldClass} mt-1`} onChange={(event) => updateJobQuery({ sort: event.target.value as GenerationJobQueryDraft["sort"] })} value={jobQuery.sort}><option value="created_desc">{t("Newest created")}</option><option value="created_asc">{t("Oldest created")}</option><option value="updated_desc">{t("Recently changed")}</option><option value="cost_desc">{t("Highest cost")}</option></select></label>
          <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{t("Page size")}<select className={`${fieldClass} mt-1`} onChange={(event) => updateJobQuery({ limit: Number(event.target.value) })} value={jobQuery.limit}>{[10, 25, 50, 100].map((limit) => <option key={limit} value={limit}>{limit}</option>)}</select></label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="min-h-10 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={jobs.loading} type="submit">{t("Apply server query")}</button>
          <button className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" disabled={jobs.loading} onClick={() => applyJobQuery(defaultGenerationJobQuery)} type="button">{t("Reset")}</button>
          {jobs.loading ? <span className="inline-flex items-center gap-2 text-xs text-[var(--ad-text-muted)]" role="status"><Loader2 className="h-4 w-4 animate-spin" />  {t("Loading complete query")}</span> : null}
        </div>
      </form>

      {jobs.error ? <AuthorityRequestError message={jobs.error} onRetry={() => void loadJobs(jobQuery)} snapshotAt={jobs.data ? jobs.refreshedAt : null} /> : null}
      {jobs.data ? (
        <section aria-label={t("Generation Job query summary")} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Matching jobs", jobs.data.summary.totalCount],
            ["Dreamcoins cost", jobs.data.summary.totalCostDreamcoins],
            ["Requested outputs", jobs.data.summary.totalOutputCount],
            ["Delivered outputs", jobs.data.summary.totalDeliveredOutputCount],
          ].map(([label, amount]) => <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3" key={label}><p className="text-xs text-[var(--ad-text-muted)]">{t(String(label))}</p><p className="mt-1 text-lg font-semibold tabular-nums">{amount}</p></div>)}
        </section>
      ) : null}

      {jobs.loading && jobs.data === null ? (
        <p className="text-sm text-[var(--ad-text-muted)]" role="status">{t("Loading authoritative jobs…")}</p>
      ) : null}
      {jobs.data ? <ReadonlyOpsView columns={columns} empty="No jobs match the server query." rows={rows} title={t("Generation Jobs")} /> : null}
      {jobs.data ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 py-3">
          <p className="text-xs text-[var(--ad-text-muted)]">

            {t("Showing")} {rows.length}  {t("of")} {jobs.data.summary.totalCount}  {t("matching jobs")}
            {" · "}{t("operational owners:")} {jobs.data.dataScope.includedDataClasses.join(" + ")}
            {" · "}{t("excluded:")} {jobs.data.dataScope.excludedDataClasses.join(" + ")}
            {" · "}{t("fresh as of")} {compactDate(jobs.data.asOf, locale)}
          </p>
          <button
            className="min-h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold disabled:opacity-50"
            disabled={jobs.loading || !jobs.data.pageInfo.hasNextPage || !jobs.data.pageInfo.endCursor}
            onClick={() => {
              const next = { ...jobQuery, cursor: jobs.data?.pageInfo.endCursor ?? undefined };
              applyJobQuery(next);
            }}
            type="button"
          >

            {t("Next page")}
          </button>
        </div>
      ) : null}
      {selectedJobId ? (
        <GenerationJobInspector
          detail={detail}
          error={detailError}
          jobId={selectedJobId}
          loading={detailBusy}
          locale={locale}
          onClose={closeJobDetail}
          onReconciled={async () => {
            await Promise.all([
              loadJobDetail(selectedJobId),
              loadJobs(jobQuery),
            ]);
          }}
        />
      ) : null}
      {retrySpec ? <ConfirmDialog onClose={() => setRetrySpec(null)} spec={retrySpec} /> : null}
    </div>
  );
}

function GenerationJobInspector({ detail, error, jobId, loading, locale, onClose, onReconciled }: {
  detail: GenerationJobDetailResponse | null;
  error: string | null;
  jobId: string;
  loading: boolean;
  locale: AdminLocale;
  onClose: () => void;
  onReconciled: () => Promise<void>;
}) {
  const { t, value } = useAdminI18n();
  const request = detail?.request ?? null;
  return (
    <section aria-labelledby="generation-job-detail-title" className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--ad-border)] p-4">
        <div className="min-w-0"><p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">{t("Generation Request authority")}</p><h2 className="mt-1 truncate font-mono text-base font-semibold" id="generation-job-detail-title">{shortId(jobId)}</h2></div>
        <button aria-label={t("Close")} autoFocus className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:bg-black/[0.04]" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
      </div>
      {loading ? <div className="flex h-28 items-center justify-center text-sm text-[var(--ad-text-muted)]" role="status"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t("Loading Request, Attempt, Delivery, and Settlement facts")}</div> : null}
      {error ? <div className="m-4 rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-3 py-2 text-sm text-[var(--ad-red-text)]" role="alert">{error}</div> : null}
      {request && detail ? (
        <div className="space-y-5 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Request outcome" value={value(request.requestOutcome)} meta={t("legacy projection: {status}", { status: value(request.legacyStatus) })} />
            <Metric label="Delivery" value={`${request.delivery.deliveredCount}/${request.delivery.expectedOutputCount}`} meta={t("{pending} pending · {failed} failed", { pending: request.delivery.pendingCount, failed: request.delivery.failedCount })} />
            <Metric label="Settlement" value={value(request.settlement.view)} meta={t("{captured} captured · {refunded} refunded", { captured: request.settlement.capturedDreamcoins, refunded: request.settlement.refundedDreamcoins })} />
            <Metric label="Freshness" value={detail.freshness} meta={compactDate(detail.asOf, locale)} />
          </div>
          <UnknownGenerationReconciliationControls
            detail={detail}
            onReconciled={onReconciled}
          />
          <AuthorityTable
            caption="Generation Attempts"
            headers={["Attempt", "Outcome", "Provider / route", "Failure authority", "Finished"]}
            rows={detail.attempts.map((attempt) => [
              `#${attempt.attemptNo} · ${shortId(attempt.id)}`,
              value(attempt.status),
              [attempt.provider, attempt.profileKey, attempt.workflowKey].filter(Boolean).join(" · ") || "—",
              [attempt.errorClass, attempt.errorCode, attempt.retryability].filter(Boolean).join(" · ") || "—",
              attempt.finishedAt ? compactDate(attempt.finishedAt, locale) : "—",
            ])}
          />
          <AuthorityTable
            caption="Provider Transport Executions"
            headers={["Transport", "Attempt / provider", "Technical outcome", "Provider cost", "Terminal record", "Finished"]}
            rows={detail.transportExecutions.map((execution) => [
              `#${execution.transportAttemptNo} · ${shortId(execution.id)}`,
              `${shortId(execution.attemptId)} · ${execution.provider ?? "—"}`,
              value(execution.status),
              execution.costMicros === null ? "Unavailable" : `${execution.costMicros.toLocaleString(locale)} μ`,
              execution.terminalRecordRef ?? "—",
              execution.finishedAt ? compactDate(execution.finishedAt, locale) : "—",
            ])}
          />
          <div className="grid gap-5 xl:grid-cols-2">
            <AuthorityTable
              caption="Artifacts and validation"
              headers={["Artifact", "Attempt", "Validation", "Archive", "Asset"]}
              rows={detail.artifacts.map((artifact) => [shortId(artifact.id), shortId(artifact.attemptId), value(artifact.validationState), value(artifact.archiveState), artifact.assetId ? shortId(artifact.assetId) : "—"])}
            />
            <AuthorityTable
              caption="Delivery outcomes"
              headers={["Artifact", "Target", "Outcome", "Delivered"]}
              rows={detail.deliveries.map((delivery) => [shortId(delivery.artifactId), `${delivery.targetType}:${shortId(delivery.targetId)}`, value(delivery.status), delivery.deliveredAt ? compactDate(delivery.deliveredAt, locale) : "—"])}
            />
          </div>
          <AuthorityTable
            caption="Immutable Attempt events"
            headers={["Sequence", "Attempt", "Typed event", "Outcome", "Occurred"]}
            rows={detail.events.map((event) => [String(event.sequence), shortId(event.attemptId), event.eventType, event.outcome ? value(event.outcome) : "—", compactDate(event.occurredAt, locale)])}
          />
          <AuthorityTable
            caption="Append-only Settlement entries"
            headers={["Ledger entry", "Kind", "Reason", "Dreamcoins", "Occurred"]}
            rows={detail.settlementEntries.map((entry) => [shortId(entry.ledgerEntryId), entry.kind, entry.reason, String(entry.deltaDreamcoins), compactDate(entry.createdAt, locale)])}
          />
          <AuthorityTable
            caption="Unknown outcome reconciliation decisions"
            headers={["Decision", "Attempt / actor", "Reason", "Evidence", "Review / settlement", "Occurred"]}
            rows={detail.unknownReconciliations.map((decision) => [
              value(decision.resolution),
              `${shortId(decision.attemptId)} · ${shortId(decision.actorId)}`,
              decision.reason,
              decision.providerEvidenceRefs.join(" · ") || "—",
              decision.nextReviewAt
                ? `${value(decision.reviewStatus)} · ${compactDate(decision.nextReviewAt, locale)}`
                : decision.deliveredCount > 0
                  ? `${decision.deliveredCount} delivered · ${decision.refundAmount} Dreamcoins refund`
                  : `${decision.refundAmount} Dreamcoins refund`,
              compactDate(decision.occurredAt, locale),
            ])}
          />
        </div>
      ) : null}
    </section>
  );
}

function AuthorityTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: string[][] }) {
  const { t } = useAdminI18n();
  const translatedCaption = t(caption);
  return (
    <div aria-label={t("{caption} scrollable table", { caption: translatedCaption })} className="overflow-x-auto rounded-lg border border-[var(--ad-border)]" role="region" tabIndex={0}>
      <table className="w-full min-w-[560px] text-left text-xs">
        <caption className="px-3 py-2 text-left text-sm font-semibold">{translatedCaption}</caption>
        <thead className="bg-black/[0.03] text-[var(--ad-text-muted)]"><tr>{headers.map((header) => <th className="px-3 py-2 font-semibold" key={header} scope="col">{t(header)}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr className="border-t border-[var(--ad-border)]" key={`${caption}-${rowIndex}`}>{row.map((cell, cellIndex) => <td className="px-3 py-2" key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}{rows.length === 0 ? <tr><td className="px-3 py-5 text-[var(--ad-text-muted)]" colSpan={headers.length}>{t("No authoritative facts recorded.")}</td></tr> : null}</tbody>
      </table>
    </div>
  );
}

function IconAction({ disabled = false, icon, label, onClick }: { disabled?: boolean; icon: ReactNode; label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const { t } = useAdminI18n();
  const displayLabel = t(label);
  return <button className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--ad-border)] px-2 text-xs text-[var(--ad-text)] hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={onClick} title={displayLabel} type="button">{icon}<span>{displayLabel}</span></button>;
}

function Metric({ label, meta, value }: { label: string; meta: string; value: ReactNode }) {
  const { t } = useAdminI18n();
  return <div className="rounded-lg border border-[var(--ad-border)] p-3"><p className="text-xs text-[var(--ad-text-muted)]">{t(label)}</p><p className="mt-1 font-semibold">{value}</p><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{meta}</p></div>;
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value || "—";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function compactDate(value: string, locale: AdminLocale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(adminDateLocale(locale), { dateStyle: "medium", timeStyle: "short" });
}
