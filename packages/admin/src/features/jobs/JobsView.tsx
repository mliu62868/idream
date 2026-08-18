"use client";

import { FileText, Loader2, RefreshCcw, X } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  generationJobDetailResponseSchema,
  generationJobListResponseSchema,
  retryGenerationRequestResultSchema,
  type GenerationJobDetailResponse,
  type GenerationJobListItem,
  type GenerationJobListResponse,
} from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { CopyableId } from "@/components/admin/ui/CopyableId";
import { DataTable, type DataTableHeader, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { FilterBar, type FilterChip } from "@/components/admin/ui/FilterBar";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { useUrlFilters } from "@/components/admin/ui/useUrlFilters";
import { adminV2Request } from "@/lib/admin-v2-api";
import {
  authorityRequestFailed,
  authorityRequestStarted,
  authorityRequestSucceeded,
  createAuthorityState,
} from "@/lib/authority-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import { useAdminI18n } from "@/components/admin/i18n";
import { FailureReason } from "@/components/admin/generation/FailureReason";
import {
  buildGenerationJobQuery,
  changedGenerationJobFilters,
  defaultGenerationJobQuery,
  generationJobLimitOptions,
  generationJobModeOptions,
  generationJobSortOptions,
  generationJobStatusOptions,
  GENERATION_JOBS_REFRESH_EVENT,
  isGenerationJobQueryFiltered,
  parseGenerationJobQuery,
  type GenerationJobFilterKey,
  type GenerationJobQueryDraft,
} from "./query";
import { UnknownGenerationReconciliationControls } from "./UnknownGenerationReconciliationControls";

const FILTER_LABELS: Record<GenerationJobFilterKey, string> = {
  search: "Search",
  mode: "Mode",
  legacyStatus: "Status",
  provider: "Provider",
  sourceType: "Source type",
  userId: "User ID",
  characterId: "Character ID",
  sort: "Sort",
};

export function JobsView() {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const [jobs, setJobs] = useState(() => createAuthorityState<GenerationJobListResponse>());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GenerationJobDetailResponse | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retrySpec, setRetrySpec] = useState<ConfirmSpec | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  // 游标分页没有页码，只有「上一页用的是哪个游标」。这条轨迹就是 Pagination 的第 N 页。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
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

  const showJobDetail = useCallback(async (id: string | null) => {
    setSelectedJobId(id);
    setDetail(null);
    setDetailError(null);
    if (!id) return;
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

  const filters = useUrlFilters<GenerationJobQueryDraft>({
    initial: defaultGenerationJobQuery,
    parse: parseGenerationJobQuery,
    toUrl: (query, location) => `${location.pathname}?${buildGenerationJobQuery(query)}`,
    load: (query, params) => {
      void loadJobs(query);
      void showJobDetail(params.get("job")?.trim() || null);
    },
  });
  const { apply, draft, pushUrl, query, reload, setDraft, urlFor } = filters;

  useEffect(() => {
    const gate = jobsGate.current;
    window.addEventListener(GENERATION_JOBS_REFRESH_EVENT, reload);
    return () => {
      gate.invalidate();
      window.removeEventListener(GENERATION_JOBS_REFRESH_EVENT, reload);
    };
  }, [reload]);

  // SPEC: 任何改变结果集的动作都回到第一页并清空勾选 —— 选中的行翻页后已经不在屏幕上了。
  function applyQuery(next: GenerationJobQueryDraft, trail: string[] = []) {
    setCursorTrail(trail);
    setSelectedRows([]);
    apply(next);
  }

  function openJobDetail(id: string, trigger: HTMLButtonElement) {
    if (!id) return;
    detailTriggerRef.current = trigger;
    pushUrl(`${urlFor(query)}&job=${encodeURIComponent(id)}`);
    void showJobDetail(id);
  }

  function closeJobDetail() {
    pushUrl(urlFor(query), "replace");
    void showJobDetail(null);
    window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
  }

  function chipValue(key: GenerationJobFilterKey, raw: string) {
    if (key === "mode") return t(generationJobModeOptions.find((option) => option.value === raw)?.label ?? raw);
    if (key === "sort") return t(generationJobSortOptions.find((option) => option.value === raw)?.label ?? raw);
    if (key === "legacyStatus") return value(raw);
    return raw;
  }

  const chips: FilterChip[] = changedGenerationJobFilters(query).map((filter) => ({
    key: filter.key,
    label: t(FILTER_LABELS[filter.key]),
    value: chipValue(filter.key, filter.value),
    onClear: () => applyQuery({ ...query, ...filter.reset, cursor: undefined }),
  }));

  const items = jobs.data?.items ?? [];
  // 「未知结果复核」大多数时候整列是 —— 。没有一行真的在复核时不占这条宽度。
  const showsUnknownReview = items.some((item) => item.unknownReview.status !== "not_applicable");
  const headers: DataTableHeader[] = [
    { label: "Job", width: "9rem" },
    { label: "User", width: "9rem" },
    // 只有创建时间在后端两个方向都排得了序；其余排序口径（改动时间 / 花费）没有对应列，留在筛选条里。
    { label: "Created", sortKey: "created", width: "11rem" },
    { label: "Request outcome", width: "8rem" },
    { label: "Settlement", width: "8rem" },
    { label: "Failure reason", width: "18rem" },
    ...(showsUnknownReview ? [{ label: "Unknown review", width: "11rem" }] : []),
    { label: "Actions", align: "right" as const, width: "8rem" },
  ];
  const rows: DataTableRow[] = items.map((item) => ({
    id: item.id,
    cells: [
      <CopyableId key="id" value={item.id} />,
      <CopyableId key="user" value={item.userId} />,
      format.dateTime(item.createdAt),
      value(item.requestOutcome),
      value(item.settlement.view),
      item.requestOutcome === "failed"
        ? <FailureReason code={item.errorCode} key="failure" />
        : <span className="text-[var(--ad-text-muted)]" key="failure">—</span>,
      ...(showsUnknownReview ? [<UnknownReviewCell item={item} key="review" />] : []),
      <div className="flex justify-end gap-1" key="actions">
        <IconAction
          icon={<FileText className="h-4 w-4" />}
          label="Details"
          onClick={(event) => openJobDetail(item.id, event.currentTarget)}
        />
        {item.requestOutcome === "failed" ? (
          <IconAction
            icon={<RefreshCcw className="h-4 w-4" />}
            label="Retry"
            onClick={() => setRetrySpec({
              title: `Retry Generation Request ${shortId(item.id)}`,
              summary: "Creates a new immutable Attempt only when no delivery has already succeeded.",
              destructive: { expectedName: `${item.id}:retry` },
              submitLabel: "Create retry attempt",
              onSubmit: async (reason) => {
                await adminV2Request(`/api/v2/admin/jobs/${encodeURIComponent(item.id)}/commands/retry`, {
                  method: "POST",
                  idempotencyKey: crypto.randomUUID(),
                  body: {
                    entityVersion: item.version,
                    reason,
                    confirmation: `${item.id}:retry`,
                  },
                  schema: retryGenerationRequestResultSchema,
                });
                await loadJobs(query);
              },
            })}
          />
        ) : null}
      </div>,
    ],
  }));

  return (
    <div className="space-y-4">
      <FilterBar
        busy={jobs.loading}
        chips={chips}
        collapsible
        inputs={[
          { name: t("Provider"), value: draft.provider, onChange: (provider) => setDraft({ provider }), list: "job-provider-facets" },
          { name: t("Source type"), value: draft.sourceType, onChange: (sourceType) => setDraft({ sourceType }), list: "job-source-facets" },
          { name: t("User ID"), value: draft.userId, onChange: (userId) => setDraft({ userId }) },
          { name: t("Character ID"), value: draft.characterId, onChange: (characterId) => setDraft({ characterId }) },
        ]}
        onApply={() => applyQuery({ ...draft, cursor: undefined })}
        onReset={() => applyQuery(defaultGenerationJobQuery)}
        onSearch={(search) => setDraft({ search })}
        search={draft.search}
        searchPlaceholder={t("Job, user, character, model, error…")}
        selects={[
          {
            name: t("Mode"),
            value: draft.mode,
            onChange: (mode) => setDraft({ mode: mode as GenerationJobQueryDraft["mode"] }),
            options: generationJobModeOptions.map((option) => ({ value: option.value, label: t(option.label) })),
          },
          {
            name: t("Status"),
            value: draft.legacyStatus,
            onChange: (legacyStatus) => setDraft({ legacyStatus }),
            options: [{ value: "", label: t("All") }, ...generationJobStatusOptions.map((status) => ({ value: status, label: value(status) }))],
          },
          {
            name: t("Sort"),
            value: draft.sort,
            onChange: (sort) => setDraft({ sort: sort as GenerationJobQueryDraft["sort"] }),
            options: generationJobSortOptions.map((option) => ({ value: option.value, label: t(option.label) })),
          },
        ]}
      >
        <datalist id="job-provider-facets">{jobs.data?.facets.providers.map((facet) => <option key={facet.value} value={facet.value}>{facet.count}</option>)}</datalist>
        <datalist id="job-source-facets">{jobs.data?.facets.sourceTypes.map((facet) => <option key={facet.value} value={facet.value}>{facet.count}</option>)}</datalist>
      </FilterBar>

      {jobs.error && jobs.data ? <AuthorityRequestError message={jobs.error} onRetry={reload} snapshotAt={jobs.refreshedAt} /> : null}
      {jobs.data ? (
        <section aria-label={t("Generation Job totals")} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Matching jobs", jobs.data.summary.totalCount],
            ["Dreamcoins cost", jobs.data.summary.totalCostDreamcoins],
            ["Requested outputs", jobs.data.summary.totalOutputCount],
            ["Delivered outputs", jobs.data.summary.totalDeliveredOutputCount],
          ].map(([label, amount]) => <div className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-3" key={label}><p className="text-xs text-[var(--ad-text-muted)]">{t(String(label))}</p><p className="mt-1 text-lg font-semibold tabular-nums">{amount}</p></div>)}
        </section>
      ) : null}

      <DataTable
        caption="Generation Jobs"
        density="compact"
        empty={
          <EmptyState
            hint={isGenerationJobQueryFiltered(query)
              ? "Widen the filters or clear them to inspect the whole authority."
              : "Generation Requests appear here as soon as the first image or video job is submitted."}
            kind={isGenerationJobQueryFiltered(query) ? "filtered" : "empty"}
            onClearFilters={isGenerationJobQueryFiltered(query) ? () => applyQuery(defaultGenerationJobQuery) : undefined}
            title={isGenerationJobQueryFiltered(query) ? "No jobs match these filters." : "No generation jobs recorded yet."}
          />
        }
        error={jobs.data ? null : jobs.error}
        headers={headers}
        loading={jobs.loading}
        minimumWidthClassName="min-w-[1080px]"
        onRetry={reload}
        rows={rows}
        selection={{
          selected: selectedRows,
          onChange: setSelectedRows,
          actions: (
            <button
              className="min-h-8 rounded-md border border-white/40 px-3 text-xs font-semibold"
              onClick={() => { void navigator.clipboard?.writeText(selectedRows.join("\n")); }}
              type="button"
            >
              {t("Copy selected IDs")}
            </button>
          ),
        }}
        skeletonRows={query.limit}
        sort={query.sort === "created_asc" ? { key: "created", direction: "asc" } : query.sort === "created_desc" ? { key: "created", direction: "desc" } : null}
        onSortChange={(next) => applyQuery({ ...query, sort: next.direction === "asc" ? "created_asc" : "created_desc", cursor: undefined })}
        stickyHeader
        stickyLastColumn
      />

      {jobs.data ? (
        <Pagination
          detail={`${t("operational owners:")} ${jobs.data.dataScope.includedDataClasses.join(" + ")} · ${t("excluded:")} ${jobs.data.dataScope.excludedDataClasses.join(" + ")} · ${t("fresh as of")} ${format.dateTime(jobs.data.asOf)}`}
          hasNext={Boolean(jobs.data.pageInfo.hasNextPage && jobs.data.pageInfo.endCursor)}
          hasPrevious={cursorTrail.length > 0}
          loading={jobs.loading}
          onNext={() => {
            const endCursor = jobs.data?.pageInfo.endCursor;
            if (!endCursor) return;
            applyQuery({ ...query, cursor: endCursor }, [...cursorTrail, query.cursor ?? ""]);
          }}
          onPageSizeChange={(limit) => applyQuery({ ...query, limit, cursor: undefined })}
          onPrevious={() => {
            const trail = cursorTrail.slice(0, -1);
            applyQuery({ ...query, cursor: cursorTrail.at(-1) || undefined }, trail);
          }}
          page={cursorTrail.length + 1}
          pageSize={query.limit}
          pageSizeOptions={generationJobLimitOptions}
          rowCount={rows.length}
          totalCount={jobs.data.summary.totalCount}
        />
      ) : null}

      {selectedJobId ? (
        <GenerationJobInspector
          detail={detail}
          error={detailError}
          jobId={selectedJobId}
          loading={detailBusy}
          onClose={closeJobDetail}
          onReconciled={async () => {
            await Promise.all([
              showJobDetail(selectedJobId),
              loadJobs(query),
            ]);
          }}
        />
      ) : null}
      {retrySpec ? <ConfirmDialog onClose={() => setRetrySpec(null)} spec={retrySpec} /> : null}
    </div>
  );
}

function UnknownReviewCell({ item }: { item: GenerationJobListItem }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const { nextReviewAt, status } = item.unknownReview;
  if (status === "not_applicable") return <span className="text-[var(--ad-text-muted)]">—</span>;
  return (
    <span className={status === "due" ? "font-semibold text-red-700" : "text-amber-700"}>
      {t(status)}{nextReviewAt ? ` · ${format.dateTime(nextReviewAt)}` : ""}
    </span>
  );
}

function GenerationJobInspector({ detail, error, jobId, loading, onClose, onReconciled }: {
  detail: GenerationJobDetailResponse | null;
  error: string | null;
  jobId: string;
  loading: boolean;
  onClose: () => void;
  onReconciled: () => Promise<void>;
}) {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
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
            <Metric label="Freshness" value={detail.freshness} meta={format.dateTime(detail.asOf)} />
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
              attempt.finishedAt ? format.dateTime(attempt.finishedAt) : "—",
            ])}
          />
          <AuthorityTable
            caption="Provider Transport Executions"
            headers={["Transport", "Attempt / provider", "Technical outcome", "Provider cost", "Terminal record", "Finished"]}
            rows={detail.transportExecutions.map((execution) => [
              `#${execution.transportAttemptNo} · ${shortId(execution.id)}`,
              `${shortId(execution.attemptId)} · ${execution.provider ?? "—"}`,
              value(execution.status),
              execution.costMicros === null ? "Unavailable" : `${format.count(execution.costMicros)} μ`,
              execution.terminalRecordRef ?? "—",
              execution.finishedAt ? format.dateTime(execution.finishedAt) : "—",
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
              rows={detail.deliveries.map((delivery) => [shortId(delivery.artifactId), `${delivery.targetType}:${shortId(delivery.targetId)}`, value(delivery.status), delivery.deliveredAt ? format.dateTime(delivery.deliveredAt) : "—"])}
            />
          </div>
          <AuthorityTable
            caption="Immutable Attempt events"
            headers={["Sequence", "Attempt", "Typed event", "Outcome", "Occurred"]}
            rows={detail.events.map((event) => [String(event.sequence), shortId(event.attemptId), event.eventType, event.outcome ? value(event.outcome) : "—", format.dateTime(event.occurredAt)])}
          />
          <AuthorityTable
            caption="Append-only Settlement entries"
            headers={["Ledger entry", "Kind", "Reason", "Dreamcoins", "Occurred"]}
            rows={detail.settlementEntries.map((entry) => [shortId(entry.ledgerEntryId), entry.kind, entry.reason, String(entry.deltaDreamcoins), format.dateTime(entry.createdAt)])}
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
                ? `${value(decision.reviewStatus)} · ${format.dateTime(decision.nextReviewAt)}`
                : decision.deliveredCount > 0
                  ? `${decision.deliveredCount} delivered · ${decision.refundAmount} Dreamcoins refund`
                  : `${decision.refundAmount} Dreamcoins refund`,
              format.dateTime(decision.occurredAt),
            ])}
          />
        </div>
      ) : null}
    </section>
  );
}

// SPEC: 详情面板里的七张只读证据表，故意不是 DataTable。
// INTENT: DataTable 的 caption 是 sr-only、空态是一整块 EmptyState、每行还要一个稳定 id——
// 七张表叠在一个抽屉里就变成七个大空块、七段看不见的标题，而这些行（事件序号、结算流水）
// 本来就没有可点进去的实体。这里要的恰恰相反：可见的小标题 + 一行灰字说"还没有记录"。
// 列表页那张真表已经在用 DataTable，这不是漏迁。
function AuthorityTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: string[][] }) {
  const { t } = useAdminI18n();
  const translatedCaption = t(caption);
  return (
    <div aria-label={t("{caption} scrollable table", { caption: translatedCaption })} className="overflow-x-auto rounded-lg border border-[var(--ad-border)]" role="region" tabIndex={0}>
      <table className="w-full min-w-[560px] text-left text-xs">
        <caption className="px-3 py-2 text-left text-sm font-semibold">{translatedCaption}</caption>
        <thead className="bg-black/[0.03] text-[var(--ad-text-muted)]"><tr>{headers.map((header) => <th className="px-3 py-2 font-semibold" key={header} scope="col">{t(header)}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr className="border-t border-[var(--ad-border)]" key={`${caption}-${rowIndex}`}>{row.map((cell, cellIndex) => <td className="px-3 py-2" key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}{rows.length === 0 ? <tr><td className="px-3 py-5 text-[var(--ad-text-muted)]" colSpan={headers.length}>{t("Nothing recorded yet.")}</td></tr> : null}</tbody>
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
  return <div className="rounded-lg border border-[var(--ad-border)] p-3"><p className="text-xs text-[var(--ad-text-muted)]">{t(label)}</p><p className="mt-1 font-semibold">{value}</p><p className="mt-1 text-xs text-[var(--ad-text-muted)]">{t(meta)}</p></div>;
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value || "—";
}

