"use client";

import { Ban, FileText, Loader2, RefreshCcw, X } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  generationJobDetailResponseSchema,
  generationJobListResponseSchema,
  isGenerationRequestCancellableStatus,
  type GenerationJobDetailResponse,
  type GenerationJobListItem,
  type GenerationJobListResponse,
} from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { useToast } from "@/components/admin/ui/Toast";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { CopyableId } from "@/components/admin/ui/CopyableId";
import { DataTable, type DataTableHeader, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { FilterBar, type FilterChip } from "@/components/admin/ui/FilterBar";
import { useAdminFormat } from "@/components/admin/ui/format";
import { Pagination } from "@/components/admin/ui/Pagination";
import { useUrlFilters } from "@/components/admin/ui/useUrlFilters";
import { useWorkspaceRefresh } from "@/features/workspace-refresh";
import { adminV2Operation } from "@/lib/admin-v2-operation";
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
  generationJobsWorkspaceUrl,
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
  from: "From",
  to: "To",
  profileId: "Profile ID",
  profileVersion: "Version",
  recipeId: "Recipe ID",
  sort: "Sort",
};

// SPEC: every write here is gated by its manifest operation; support / moderator roles only hold
//       generation.job.read and must not be shown a button that 403s after the confirmation.
export type JobsViewPermissions = { readonly retry: boolean; readonly cancel: boolean; readonly reconcile: boolean };

export function JobsView({ permissions }: { readonly permissions: JobsViewPermissions }) {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const [jobs, setJobs] = useState(() => createAuthorityState<GenerationJobListResponse>());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GenerationJobDetailResponse | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const { toast } = useToast();
  const [retrySpec, setRetrySpec] = useState<ConfirmSpec | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  // INVARIANT: only a trail starting at the first page proves a page number.
  // Browser history restores the trail for the exact query, including its cursor.
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const visitedTrails = useRef(new Map<string, string[]>());
  const activeQuery = useRef<string | null>(null);
  // A receipt may finish after navigation; it only owns its original confirmation.
  const confirmationIntent = useRef<ConfirmSpec | null>(null);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const jobsGate = useRef(createLatestRequestGate());
  const detailGate = useRef(createLatestRequestGate());

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
    const request = detailGate.current.begin();
    setSelectedJobId(id);
    setDetail(null);
    setDetailError(null);
    setDetailBusy(Boolean(id));
    if (!id) return;
    try {
      const response = generationJobDetailResponseSchema.parse(
        await apiGet<unknown>(`/api/v2/admin/jobs/${encodeURIComponent(id)}`),
      );
      if (request.isCurrent()) setDetail(response);
    } catch (cause) {
      if (request.isCurrent()) setDetailError(cause instanceof Error ? cause.message : t("Job detail load failed"));
    } finally {
      if (request.isCurrent()) setDetailBusy(false);
    }
  }, [t]);

  const filters = useUrlFilters<GenerationJobQueryDraft>({
    initial: defaultGenerationJobQuery,
    parse: parseGenerationJobQuery,
    toUrl: (query, location) => generationJobsWorkspaceUrl(
      location.pathname,
      location.search,
      query,
    ),
    load: (query, params) => {
      const encoded = buildGenerationJobQuery(query);
      if (activeQuery.current !== encoded) {
        setSelectedRows([]);
        confirmationIntent.current = null;
        setRetrySpec(null);
        activeQuery.current = encoded;
      }
      if (!query.cursor) visitedTrails.current.set(encoded, []);
      setCursorTrail(visitedTrails.current.get(encoded) ?? []);
      void loadJobs(query);
      void showJobDetail(params.get("job")?.trim() || null);
    },
  });
  const { apply, draft, pushUrl, query, reload, setDraft } = filters;

  useWorkspaceRefresh(reload);

  useEffect(() => {
    const gate = jobsGate.current;
    const details = detailGate.current;
    window.addEventListener(GENERATION_JOBS_REFRESH_EVENT, reload);
    return () => {
      gate.invalidate();
      details.invalidate();
      confirmationIntent.current = null;
      window.removeEventListener(GENERATION_JOBS_REFRESH_EVENT, reload);
    };
  }, [reload]);

  // SPEC: 任何改变结果集的动作都回到第一页并清空勾选 —— 选中的行翻页后已经不在屏幕上了。
  function applyQuery(next: GenerationJobQueryDraft, trail: string[] = []) {
    visitedTrails.current.set(buildGenerationJobQuery(next), trail);
    setSelectedRows([]);
    apply(next);
  }

  function openJobDetail(id: string, trigger: HTMLButtonElement) {
    if (!id) return;
    detailTriggerRef.current = trigger;
    pushUrl(generationJobsWorkspaceUrl(
      window.location.pathname,
      window.location.search,
      query,
      { jobId: id },
    ));
    void showJobDetail(id);
  }

  function closeJobDetail() {
    pushUrl(generationJobsWorkspaceUrl(
      window.location.pathname,
      window.location.search,
      query,
      { jobId: null },
    ), "replace");
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
      item.settlement.view === "not_required" ? t("No settlement needed") : value(item.settlement.view),
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
        {permissions.retry && item.requestOutcome === "failed" ? (
          <IconAction
            icon={<RefreshCcw className="h-4 w-4" />}
            label="Retry"
            onClick={() => {
              const spec: ConfirmSpec = {
                // ui/ConfirmDialog 直接渲染 spec 的 title/summary/submitLabel，不过 t()——
                // 所以在调用点翻译，和本仓库其它 ConfirmSpec 调用点一致。
                title: t("Retry Generation Request {id}", { id: shortId(item.id) }),
                summary: t("Creates a new immutable Attempt only when no delivery has already succeeded."),
                destructive: { expectedName: `${item.id}:retry` },
                submitLabel: t("Create retry attempt"),
                onSubmit: async (reason) => {
                  if (confirmationIntent.current !== spec) return;
                  await adminV2Operation("POST /api/v2/admin/jobs/:id/commands/retry", {
                    path: { id: item.id },
                    body: {
                      entityVersion: item.version,
                      reason,
                      confirmation: `${item.id}:retry`,
                    },
                  });
                  if (confirmationIntent.current !== spec) return;
                  await loadJobs(query);
                },
              };
              confirmationIntent.current = spec;
              setRetrySpec(spec);
            }}
          />
        ) : null}
        {/* SPEC: 还在飞的请求要有一个人工中止阀。
            INTENT: 这一页此前只有 Retry（仅 failed）和 unknown 对账，对着一个排队一小时、
            或 running 不动的请求，运营的选项是零个。后端 `POST /generation/requests/:id/commands/cancel`
            （generation-request-lifecycle.ts:19）一直在那儿且做的是完整收尾：Serializable 事务里
            迁到 cancelled、写终态 attempt 事件、取消 dispatch outbox、退还 Dreamcoin、把队列 job 摘掉；
            但控制台一次都没调过它。
            INVARIANT: 显示条件按 legacyStatus 取，和后端允许的迁移源
            `["queued","moderating_input","running","moderating_output"]` 逐字对齐——
            按 requestOutcome 判会把 needs_reconciliation 这类也放进来，点下去必然 conflict。 */}
        {permissions.cancel && isGenerationRequestCancellableStatus(item.legacyStatus) ? (
          <IconAction
            icon={<Ban className="h-4 w-4" />}
            // INVARIANT: 不要用通用的 "Cancel"。它在字典里是「取消」，和弹窗上那个"取消/不做了"
            //            是同一个词；摆在「详情」旁边的操作列里，运营会把"中止这次生成"读成
            //            "关掉这一行"。这里要的是一个只有一种意思的动词。
            label="Abort"
            onClick={() => {
              const spec: ConfirmSpec = {
                title: t("Cancel Generation Request {id}", { id: shortId(item.id) }),
                summary: t("Stops the in-flight request, marks it cancelled, and refunds the reserved Dreamcoins."),
                consequence: {
                  effect: t("The user's request ends with no output. Re-running means a new request at full price."),
                  reversible: false,
                },
                destructive: { expectedName: `${item.id}:cancel` },
                submitLabel: t("Cancel request"),
                onSubmit: async (reason) => {
                  if (confirmationIntent.current !== spec) return;
                  const result = await adminV2Operation("POST /api/v2/admin/generation/requests/:id/commands/cancel", {
                    path: { id: item.id },
                    body: {
                      entityVersion: item.version,
                      reason,
                      confirmation: `${item.id}:cancel`,
                    },
                  });
                  if (confirmationIntent.current !== spec) return;
                  toast({
                    tone: "success",
                    title: t("Request cancelled · {amount} Dreamcoins refunded", { amount: result.refundAmount }),
                  });
                  await loadJobs(query);
                },
              };
              confirmationIntent.current = spec;
              setRetrySpec(spec);
            }}
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
          { name: t("From"), value: draft.from, onChange: (from) => setDraft({ from }), placeholder: "2026-10-01T00:00:00.000Z" },
          { name: t("To"), value: draft.to, onChange: (to) => setDraft({ to }), placeholder: "2026-10-08T00:00:00.000Z" },
          { name: t("Profile ID"), value: draft.profileId, onChange: (profileId) => setDraft({ profileId }) },
          { name: t("Version"), value: draft.profileVersion, onChange: (profileVersion) => setDraft({ profileVersion }) },
          { name: t("Recipe ID"), value: draft.recipeId, onChange: (recipeId) => setDraft({ recipeId }) },
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
          hasPrevious={Boolean(query.cursor)}
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
          previousLabel={query.cursor && cursorTrail.length === 0 ? t("Back to first page") : undefined}
          page={!query.cursor ? 1 : cursorTrail[0] === "" ? cursorTrail.length + 1 : null}
          pageSize={query.limit}
          pageSizeOptions={generationJobLimitOptions}
          rowCount={rows.length}
          totalCount={jobs.data.summary.totalCount}
        />
      ) : null}

      {selectedJobId ? (
        <GenerationJobInspector
          canReconcile={permissions.reconcile}
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
      {retrySpec ? <ConfirmDialog onClose={() => {
        if (confirmationIntent.current === retrySpec) confirmationIntent.current = null;
        setRetrySpec((current) => current === retrySpec ? null : current);
      }} spec={retrySpec} /> : null}
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

function GenerationJobInspector({ canReconcile, detail, error, jobId, loading, onClose, onReconciled }: {
  canReconcile: boolean;
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
        <div className="min-w-0"><p className="text-xs font-semibold uppercase text-[var(--ad-text-muted)]">{t("Generation Request authority")}</p><h2 className="mt-1 font-mono text-base font-semibold" id="generation-job-detail-title"><CopyableId value={jobId} /></h2></div>
        <div className="flex shrink-0 items-center gap-2">
          {/* SPEC: 这一页把机器侧的事实列全了，人侧的一条没有——运营动过什么，只在审计日志里。
              INTENT: 实测把一个 23 天前的死信重新入队后，页面上凭空多出一个 Attempt #2，
              而七张证据表没有一处说得出是谁、什么时候、为什么让它重跑：requeue 走的是
              writeDeadLetterAudit（generation/dead-letter.ts:374），落在 adminAuditLog 上，
              且 `generation_attempts.sourceCommandId` 实测 119 条全是 NULL，连不回命令。
              审计接口按 targetId 全文检索是通的（search=<jobId> 实测精确命中那条 requeue），
              所以这里给一条带筛选的直达链接，而不是在详情接口里再复制一份人侧事实。 */}
          <a
            className="rounded-lg border border-[var(--ad-border)] px-2.5 py-1.5 text-xs text-[var(--ad-text-muted)] hover:bg-black/[0.04] hover:text-[var(--ad-ink)]"
            href={`/admin/system/audit?auditSearch=${encodeURIComponent(jobId)}`}
          >
            {t("Operator actions on this job")}
          </a>
          <button aria-label={t("Close")} autoFocus className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--ad-border)] text-[var(--ad-text-muted)] hover:bg-black/[0.04]" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {loading ? <div className="flex h-28 items-center justify-center text-sm text-[var(--ad-text-muted)]" role="status"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t("Loading Request, Attempt, Delivery, and Settlement facts")}</div> : null}
      {error ? <div className="m-4 rounded-lg border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] px-3 py-2 text-sm text-[var(--ad-red-text)]" role="alert">{error}</div> : null}
      {request && detail ? (
        <div className="space-y-5 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Request outcome" value={value(request.requestOutcome)} meta={t("legacy projection: {status}", { status: value(request.legacyStatus) })} />
            <Metric label="Delivery" value={`${request.delivery.deliveredCount}/${request.delivery.expectedOutputCount}`} meta={t("{pending} pending · {failed} failed", { pending: request.delivery.pendingCount, failed: request.delivery.failedCount })} />
            <Metric label="Settlement" value={request.settlement.view === "not_required" ? t("No settlement needed") : value(request.settlement.view)} meta={t("{captured} captured · {refunded} refunded", { captured: request.settlement.capturedDreamcoins, refunded: request.settlement.refundedDreamcoins })} />
            <Metric label="Freshness" value={value(detail.freshness)} meta={format.dateTime(detail.asOf)} />
          </div>
          <UnknownGenerationReconciliationControls
            canReconcile={canReconcile}
            detail={detail}
            onReconciled={onReconciled}
          />
          <AuthorityTable
            caption="Generation Attempts"
            headers={["Attempt", "Outcome", "Provider / route", "Failure authority", "Finished"]}
            rows={detail.attempts.map((attempt) => [
              <span className="inline-flex items-center gap-1" key="attempt">{`#${attempt.attemptNo} ·`} <CopyableId value={attempt.id} /></span>,
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
              <span className="inline-flex items-center gap-1" key="transport">{`#${execution.transportAttemptNo} ·`} <CopyableId value={execution.id} /></span>,
              <span className="inline-flex items-center gap-1" key="attempt-provider"><CopyableId value={execution.attemptId} />{" · "}{execution.provider ?? "—"}</span>,
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
              rows={detail.artifacts.map((artifact) => [<CopyableId key="artifact" value={artifact.id} />, <CopyableId key="attempt" value={artifact.attemptId} />, value(artifact.validationState), value(artifact.archiveState), <CopyableId key="asset" value={artifact.assetId ?? ""} />])}
            />
            <AuthorityTable
              caption="Delivery outcomes"
              headers={["Artifact", "Target", "Outcome", "Delivered"]}
              rows={detail.deliveries.map((delivery) => [<CopyableId key="artifact" value={delivery.artifactId} />, <span className="inline-flex items-center gap-1" key="target">{delivery.targetType}{":"}<CopyableId value={delivery.targetId} /></span>, value(delivery.status), delivery.deliveredAt ? format.dateTime(delivery.deliveredAt) : "—"])}
            />
          </div>
          {/* SPEC: 用户对这次生成打的分——运营手上唯一的第一手「产出到底行不行」信号。
              INTENT: `GenerationFeedback` 表在 admin-v2 里此前零引用：主站一直在收
              （`modules/ourdream/media-feedback.ts:160`），实测库里 4 条真实反馈、其中一条
              `identity/mismatch`，而后台任何一页都看不到。运营处理一次生成投诉时，读得到机器侧
              全部事实，唯独读不到用户自己怎么说的。
              INVARIANT: 同时给 revision 与「是否有效」。用户能改评价（supersedesId 链），
              只显示最新一条会抹掉"先说不像、后来改口"，只显示全部又分不清哪条算数。 */}
          <AuthorityTable
            caption="User feedback on this generation"
            headers={["Feedback", "User", "Asset", "Verdict", "Surface", "Standing", "Recorded"]}
            rows={detail.feedback.map((entry) => [
              <CopyableId key="feedback" value={entry.id} />,
              <CopyableId key="actor" value={entry.actorId} />,
              <CopyableId key="asset" value={entry.mediaAssetId} />,
              `${value(entry.dimension)} · ${value(entry.value)}`,
              value(entry.sourceSurface),
              entry.active
                ? t("Current (rev {revision})", { revision: entry.revision })
                : t("Superseded (rev {revision})", { revision: entry.revision }),
              format.dateTime(entry.createdAt),
            ])}
          />
          <AuthorityTable
            caption="Immutable Attempt events"
            headers={["Sequence", "Attempt", "Typed event", "Outcome", "Occurred"]}
            rows={detail.events.map((event) => [String(event.sequence), <CopyableId key="attempt" value={event.attemptId} />, event.eventType, event.outcome ? value(event.outcome) : "—", format.dateTime(event.occurredAt)])}
          />
          <AuthorityTable
            caption="Append-only Settlement entries"
            headers={["Ledger entry", "Kind", "Reason", "Dreamcoins", "Occurred"]}
            rows={detail.settlementEntries.map((entry) => [<CopyableId key="ledger" value={entry.ledgerEntryId} />, entry.kind, entry.reason, String(entry.deltaDreamcoins), format.dateTime(entry.createdAt)])}
          />
          <AuthorityTable
            caption="Unknown outcome reconciliation decisions"
            headers={["Decision", "Attempt / actor", "Reason", "Evidence", "Review / settlement", "Occurred"]}
            rows={detail.unknownReconciliations.map((decision) => [
              value(decision.resolution),
              <span className="inline-flex items-center gap-1" key="attempt-actor"><CopyableId value={decision.attemptId} />{" · "}<CopyableId value={decision.actorId} /></span>,
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

// SPEC: 详情面板里的只读证据表，故意不是 DataTable。
// INTENT: DataTable 的 caption 是 sr-only、空态是一整块 EmptyState、每行还要一个稳定 id——
// 多张表叠在一个抽屉里就变成多个大空块、看不见的标题，而这些行（事件序号、结算流水）
// 本来就没有可点进去的实体。这里要的恰恰相反：可见的小标题 + 一行灰字说"还没有记录"。
// 列表页那张真表已经在用 DataTable，这不是漏迁。
function AuthorityTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: ReactNode[][] }) {
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
