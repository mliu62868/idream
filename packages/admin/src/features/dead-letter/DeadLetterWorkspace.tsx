"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCcw, Trash2, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableHeader, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { text, useAdminFormat } from "@/components/admin/ui/format";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { useToast, type ToastInput } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  deadLetterConfirmation,
  deadLetterListPath,
  deadLetterQueryFromSearch,
  deadLetterWorkspaceUrl,
  defaultDeadLetterQuery,
  isDeadLetterQueryFiltered,
  type DeadLetterQuery,
} from "./query";

type DeadLetterRecord = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type ListResponse = { items: DeadLetterRecord[]; pageInfo?: PageInfo };
type RetryVerdict = { eligible: boolean; reason: string };
type Skipped = { id: string; reason: string };
type Translate = (key: string, values?: Record<string, string | number>) => string;

const PAGE_SIZE = 25;
const HEADERS: DataTableHeader[] = [
  "Job",
  "User",
  "Mode",
  "Status",
  "Provider",
  "Failure reason",
  "Replay authority",
  "Ledger",
  "Cost",
  "Updated",
  "Actions",
];
// 批量按钮长在 DataTable 的深色选中条上——边框和字都得跟着反过来。
const BULK_ACTION_CLASS =
  "inline-flex min-h-8 items-center gap-2 rounded-md border border-white/40 px-3 text-xs font-semibold disabled:opacity-40";

// SPEC: `deriveGenerationJobState` 已经判定过每条请求能不能安全重放，理由是这四个之一。
// INTENT: 前端只翻译这个判定，不自己用 status 再猜一遍——认不出来的理由如实说"未识别"并露出原码，
// 绝不编一个好听的解释（后台有假 reason 守卫测试）。
const RETRY_BLOCKED_LABELS: Record<string, string> = {
  successful_artifact_exists: "A delivered artifact already exists",
  not_failed: "The authority recorded no failure",
  refunded: "The charge was already refunded",
};

// 批量命令跳过某条时后端回的理由；与上面同源，另加两个只在批量路径出现的。
const SKIP_LABELS: Record<string, string> = {
  ...RETRY_BLOCKED_LABELS,
  not_found: "The request no longer exists",
  not_discardable: "Only failed, blocked, or refunded requests can be discarded",
};

export function DeadLetterWorkspace({ permissions }: { permissions: { requeue: boolean; discard: boolean } }) {
  const { t, value: enumLabel } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const [query, setQuery] = useState<DeadLetterQuery>(() => currentQuery());
  const [draft, setDraft] = useState<DeadLetterQuery>(() => currentQuery());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: DeadLetterQuery) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ListResponse>(deadLetterListPath(next));
      if (!request.isCurrent()) return;
      setData(response);
      setSelected([]);
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) setError(cause);
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const gate = requestGate.current;
    void load(initialQuery.current);
    const restore = () => restoreFromUrl(load, setQuery, setDraft);
    const refresh = () => restoreFromUrl(load, setQuery, setDraft);
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      gate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load]);

  function navigate(next: DeadLetterQuery, mode: "push" | "replace" = "push") {
    const url = deadLetterWorkspaceUrl(window.location.pathname, window.location.search, next);
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    setQuery(next);
    setDraft(next);
    void load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  const rows = data?.items ?? [];
  const selectedRequeueIds = rows
    .filter((row) => selected.includes(text(row.id)) && requeueAllowed(row))
    .map((row) => text(row.id));
  const selectedDiscardIds = rows
    .filter((row) => selected.includes(text(row.id)) && discardAllowed(row))
    .map((row) => text(row.id));

  function requestAction(input: {
    title: string;
    /** ConfirmDialog 的红色后果横幅原文——不可撤销动作在敲确认串之前就要读到它。 */
    effect: string;
    endpoint: string;
    ids: string[];
    kind: "requeue" | "discard";
    reasonRequired: boolean;
    allowed: boolean;
  }) {
    if (!input.allowed || input.ids.length === 0) return;
    const expected = deadLetterConfirmation(input.ids);
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: input.title,
      consequence: { effect: input.effect, reversible: false },
      destructive: { expectedName: expected, inputLabel: t("Confirmation") },
      requireReason: input.reasonRequired,
      reasonLabel: t("Reason (≥3)"),
      submitLabel: t("Confirm"),
      onSubmit: async (reason) => {
        const isBatch = input.endpoint.includes("/dead-letter/commands/");
        const result = await apiWrite<unknown>(input.endpoint, "POST", isBatch
          ? { jobIds: input.ids, reason, confirmation: expected }
          : { ...(reason ? { reason } : {}), confirmation: expected }, {
          "idempotency-key": idempotencyKey,
        });
        toast(describeOutcome(t, input.kind, input.ids, result));
        setSelected([]);
        await load({ ...query, cursor: "" });
      },
    });
  }

  function enumOr(value: unknown) {
    return typeof value === "string" && value ? enumLabel(value) : format.display(value);
  }

  const tableRows: DataTableRow[] = rows.map((row) => {
    const id = text(row.id);
    return {
      id,
      cells: [
        <a
          className="font-mono text-xs underline decoration-dotted underline-offset-2 hover:text-[var(--ad-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
          href={`/admin/ops/jobs?job=${encodeURIComponent(id)}`}
          key="job"
        >
          {id}
        </a>,
        <span className="font-mono text-xs" key="user">{text(row.userId)}</span>,
        enumOr(row.mode),
        enumOr(row.status),
        format.display(row.provider),
        text(row.errorCode) || "—",
        <RetryAuthority key="retry" verdict={retryVerdict(row.retryEligibility)} />,
        enumOr(row.ledgerState),
        format.display(row.costDreamcoins),
        format.dateTime(row.updatedAt),
        <div className="flex gap-1" key="actions">
          {permissions.requeue && requeueAllowed(row) ? <ActionButton icon={<RefreshCcw className="h-4 w-4" />} label={t("Requeue")} onClick={() => requestAction({
            allowed: permissions.requeue,
            title: t("Requeue {id}", { id }),
            effect: requeueEffect(t, 1, 0),
            endpoint: `/api/v2/admin/generation/dead-letter/${id}/commands/requeue`,
            ids: [id],
            kind: "requeue",
            reasonRequired: false,
          })} /> : null}
          {permissions.discard && discardAllowed(row) ? <ActionButton danger icon={<Trash2 className="h-4 w-4" />} label={t("Discard")} onClick={() => requestAction({
            allowed: permissions.discard,
            title: t("Discard {id}", { id }),
            effect: discardEffect(t, 1, 0),
            endpoint: `/api/v2/admin/generation/dead-letter/${id}/commands/discard`,
            ids: [id],
            kind: "discard",
            reasonRequired: true,
          })} /> : null}
          {!permissions.requeue && !permissions.discard ? t("Read only") : null}
        </div>,
      ],
    };
  });

  const filtered = isDeadLetterQueryFiltered(query);
  // 只读运营勾不动任何批量命令；给他们一列永远无效的勾选框只是噪音。
  const canSelect = permissions.requeue || permissions.discard;
  const errorMessage = error === null ? null : authorityMessage(error);
  return (
    <section aria-labelledby="dead-letter-workspace-title" className="space-y-5">
      <div id="dead-letter-workspace-title">
        <PageHeader purpose={t("Triage failed and blocked generation requests, then requeue or discard them through audited authority commands.")} title={t("Dead-letter")} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status">
        <span>{freshnessLabel(t, format.time, data, loading, error, refreshedAt)}</span>
        <span className="flex gap-3 font-semibold">
          {!permissions.requeue ? <span>{t("Requeue unavailable · generation.job.requeue is not granted")}</span> : null}
          {!permissions.discard ? <span>{t("Discard unavailable · ops.deadletter.write is not granted")}</span> : null}
        </span>
      </div>

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_160px_160px_220px_auto]" onSubmit={apply}>
        <Field label="Search job, user, provider, or error" onChange={(search) => setDraft((current) => ({ ...current, search }))} search value={draft.search} />
        <Select label="Mode" onChange={(mode) => setDraft((current) => ({ ...current, mode }))} options={["", "image", "video"]} value={draft.mode} />
        <Select label="Status" onChange={(status) => setDraft((current) => ({ ...current, status }))} options={["", "failed", "blocked"]} value={draft.status} />
        <Field label="Error code" onChange={(errorCode) => setDraft((current) => ({ ...current, errorCode }))} value={draft.errorCode} />
        <div className="flex items-end gap-2">
          <button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]" type="submit">{t("Apply")}</button>
          {filtered ? <button aria-label={t("Clear dead-letter filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={() => navigate(defaultDeadLetterQuery)} type="button"><X className="h-4 w-4" /></button> : null}
        </div>
      </form>

      {/* 还有上一份快照时把失败压成横幅，表格继续显示旧数据；没有快照时交给 DataTable 自己报错。 */}
      {error !== null && data ? (
        <AuthorityRequestError cause={error} message={authorityMessage(error)} onRetry={() => void load(query)} snapshotAt={refreshedAt} />
      ) : null}

      <DataTable
        caption="Dead-letter Queue"
        empty={<EmptyState hint={t(filtered ? "The complete dead-letter authority query returned no matches." : "No failed or blocked generation requests require triage.")} kind={filtered ? "filtered" : "empty"} onClearFilters={filtered ? () => navigate(defaultDeadLetterQuery) : undefined} title={t(canonicalListEmptyTitle("dead_letter", filtered))} />}
        error={data ? null : errorMessage}
        headers={HEADERS}
        loading={loading}
        minimumWidthClassName="min-w-[1120px]"
        onRetry={() => void load(query)}
        rows={tableRows}
        selection={canSelect ? {
          selected,
          onChange: setSelected,
          actions: (
            <>
              {permissions.requeue ? (
                <button className={BULK_ACTION_CLASS} disabled={selectedRequeueIds.length === 0} onClick={() => requestAction({
                  allowed: permissions.requeue,
                  title: t("Requeue {count} requests", { count: selectedRequeueIds.length }),
                  effect: requeueEffect(t, selectedRequeueIds.length, selected.length - selectedRequeueIds.length),
                  endpoint: "/api/v2/admin/generation/dead-letter/commands/requeue",
                  ids: selectedRequeueIds,
                  kind: "requeue",
                  reasonRequired: true,
                })} type="button">
                  <RefreshCcw className="h-4 w-4" />{t("Requeue selected")}
                  <span className="font-mono">({selectedRequeueIds.length})</span>
                </button>
              ) : null}
              {permissions.discard ? (
                <button className={BULK_ACTION_CLASS} disabled={selectedDiscardIds.length === 0} onClick={() => requestAction({
                  allowed: permissions.discard,
                  title: t("Discard {count} requests", { count: selectedDiscardIds.length }),
                  effect: discardEffect(t, selectedDiscardIds.length, selected.length - selectedDiscardIds.length),
                  endpoint: "/api/v2/admin/generation/dead-letter/commands/discard",
                  ids: selectedDiscardIds,
                  kind: "discard",
                  reasonRequired: true,
                })} type="button">
                  <Trash2 className="h-4 w-4" />{t("Discard selected")}
                  <span className="font-mono">({selectedDiscardIds.length})</span>
                </button>
              ) : null}
            </>
          ),
        } : undefined}
        skeletonRows={PAGE_SIZE}
        stickyLastColumn
      />

      {data?.pageInfo?.hasNextPage && data.pageInfo.endCursor ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" disabled={loading} onClick={() => navigate({ ...query, cursor: data.pageInfo?.endCursor ?? "" })} type="button"><RefreshCcw className="h-4 w-4" />{t("Next dead-letter page")}</button> : null}
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

function requeueEffect(t: Translate, count: number, skipped: number) {
  const effect = t("{count} requests re-enter the generation queue and are charged for a new attempt. Retrying inside this dialog reuses the same idempotency key and cannot apply twice.", { count });
  return skipped > 0
    ? `${effect} ${t("{count} selected requests the authority will not retry are excluded.", { count: skipped })}`
    : effect;
}

function discardEffect(t: Translate, count: number, skipped: number) {
  const effect = t("Discard settles the customer: any charge that was never refunded is refunded now, and the request leaves the queue for good. {count} requests are affected. Retrying inside this dialog reuses the same idempotency key and cannot apply twice.", { count });
  return skipped > 0
    ? `${effect} ${t("{count} selected requests the authority will not discard are excluded.", { count: skipped })}`
    : effect;
}

function RetryAuthority({ verdict }: { verdict: RetryVerdict | null }) {
  const { t } = useAdminI18n();
  if (!verdict) return <span className="text-xs text-[var(--ad-text-muted)]">{t("Not reported")}</span>;
  if (verdict.eligible) {
    return <span className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--ad-green-text)]"><CheckCircle2 className="h-3.5 w-3.5" />{t("Safe to requeue")}</span>;
  }
  const label = RETRY_BLOCKED_LABELS[verdict.reason];
  return (
    <span className="inline-flex items-start gap-1 text-xs text-[var(--ad-yellow-text)]">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{label ? t(label) : <>{t("Reason not recognised")} <code className="font-mono">{verdict.reason || "—"}</code></>}</span>
    </span>
  );
}

// SPEC: 只有后端说 eligible 才亮 Requeue。后端没报这个字段时退回旧口径（status === "failed"），
// 免得契约漂移直接把按钮全关掉。
function requeueAllowed(row: DeadLetterRecord) {
  const verdict = retryVerdict(row.retryEligibility);
  return verdict ? verdict.eligible : text(row.status) === "failed";
}

function discardAllowed(row: DeadLetterRecord) {
  return ["failed", "blocked", "refunded"].includes(text(row.status));
}

function retryVerdict(value: unknown): RetryVerdict | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { eligible?: unknown; reason?: unknown };
  if (typeof record.eligible !== "boolean") return null;
  return { eligible: record.eligible, reason: typeof record.reason === "string" ? record.reason : "" };
}

// SPEC: 命令结果直接来自后端的 requeued/discarded/refunded/skipped，不做任何乐观汇总。
// INTENT: 旧实现固定弹 "Requeue N jobs completed."——后端全部 skip 时也这么说。
// INTENT: 有 skip 就报 error 语气：toast 里只有 error 不自动消失，而"哪几条没做、为什么"
// 恰恰是运营唯一必须留在屏幕上读完的东西。
function describeOutcome(
  t: Translate,
  kind: "requeue" | "discard",
  requested: readonly string[],
  result: unknown,
): ToastInput {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  const skipped = readSkipped(record.skipped);
  const tone = skipped.length > 0 ? "error" as const : "success" as const;
  const description = skipped.length > 0
    ? t("Skipped · {details}", { details: skipped.map((entry) => skippedLine(t, entry)).join("；") })
    : undefined;
  if (kind === "requeue") {
    const done = readIds(record.requeued) ?? (record.queued === true ? [...requested] : []);
    const attemptNo = typeof record.attemptNo === "number" ? record.attemptNo : null;
    return {
      tone,
      title: attemptNo !== null
        ? t("Requeued {id} as attempt {attemptNo}.", { attemptNo, id: requested[0] ?? "" })
        : t("Requeued {done} of {total} requests.", { done: done.length, total: requested.length }),
      description,
    };
  }
  const done = readIds(record.discarded) ?? (record.discarded === true ? [...requested] : []);
  const refunded = readIds(record.refunded) ?? (record.refunded === true ? [...requested] : []);
  return {
    tone,
    title: t("Discarded {done} of {total} requests · {refunded} refunded.", {
      done: done.length,
      refunded: refunded.length,
      total: requested.length,
    }),
    description,
  };
}

function skippedLine(t: Translate, entry: Skipped) {
  const label = SKIP_LABELS[entry.reason];
  return `${entry.id} · ${label ? t(label) : `${t("Reason not recognised")} (${entry.reason})`}`;
}

function readIds(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function readSkipped(value: unknown): Skipped[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as { id?: unknown; reason?: unknown };
    return typeof record.id === "string"
      ? [{ id: record.id, reason: typeof record.reason === "string" ? record.reason : "" }]
      : [];
  });
}

function restoreFromUrl(load: (query: DeadLetterQuery) => Promise<void>, setQuery: (query: DeadLetterQuery) => void, setDraft: (query: DeadLetterQuery) => void) {
  const restored = currentQuery();
  setQuery(restored);
  setDraft(restored);
  void load(restored);
}

function currentQuery() {
  return typeof window === "undefined" ? defaultDeadLetterQuery : deadLetterQueryFromSearch(window.location.search);
}

function authorityMessage(error: unknown) {
  return error instanceof Error ? error.message : "Dead-letter authority request failed";
}

function freshnessLabel(
  t: Translate,
  formatTime: (value: unknown) => string,
  data: ListResponse | null,
  loading: boolean,
  error: unknown,
  refreshedAt: string | null,
) {
  const time = refreshedAt ? formatTime(refreshedAt) : t("unknown");
  if (loading && data) return t("refreshing · as of {time}", { time });
  if (error !== null && data) return t("stale · last good {time}", { time });
  if (error !== null) return t("unavailable");
  if (data) return t("as of {time}", { time });
  return t("loading…");
}

function Field({ label, onChange, search = false, value }: { label: string; onChange: (value: string) => void; search?: boolean; value: string }) {
  const { t } = useAdminI18n();
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} role={search ? "searchbox" : undefined} value={value} /></label>;
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string }) {
  const { t, value: enumLabel } = useAdminI18n();
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? enumLabel(option) : t("All")}</option>)}</select></label>;
}

function ActionButton({ danger = false, icon, label, onClick }: { danger?: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  const { t } = useAdminI18n();
  return <button className={`inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)] disabled:opacity-40 ${danger ? "text-[var(--ad-red-text)]" : "text-[var(--ad-text)]"}`} onClick={onClick} type="button">{icon}{t(label)}</button>;
}
