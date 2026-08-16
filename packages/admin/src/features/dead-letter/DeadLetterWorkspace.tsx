"use client";

import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode, Ref } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCcw, Trash2, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
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
type Notice = { tone: "ok" | "warn"; summary: string; skipped: Skipped[] };

// SPEC: `deriveGenerationJobState` 已经判定过每条请求能不能安全重放，理由是这四个之一。
// INTENT: 前端只翻译这个判定，不自己用 status 再猜一遍——认不出来的理由如实说"未识别"并露出原码，
//         绝不编一个好听的解释（后台有假 reason 守卫测试）。
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
  const { locale, t, value: enumLabel } = useAdminI18n();
  const [query, setQuery] = useState<DeadLetterQuery>(() => currentQuery());
  const [draft, setDraft] = useState<DeadLetterQuery>(() => currentQuery());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);
  const noticeRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (next: DeadLetterQuery) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ListResponse>(deadLetterListPath(next));
      if (!request.isCurrent()) return;
      setData(response);
      setSelected(new Set());
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) setError(cause instanceof Error ? cause.message : "Dead-letter authority request failed");
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

  // INTENT: 单行的 Requeue/Discard 按钮可能在第 40 行——结果横幅留在表头上方就在视口外，
  //         运营会以为没反应再点一次。命令结束后把焦点移到结果上，浏览器负责滚动，读屏也会念。
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

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
  const rowIds = rows.map((row) => text(row.id)).filter(Boolean);
  const selectedIds = rowIds.filter((id) => selected.has(id));
  const allSelected = rowIds.length > 0 && selectedIds.length === rowIds.length;
  const selectedRequeueIds = rows
    .filter((row) => selected.has(text(row.id)) && requeueAllowed(row))
    .map((row) => text(row.id));
  const selectedDiscardIds = rows
    .filter((row) => selected.has(text(row.id)) && discardAllowed(row))
    .map((row) => text(row.id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestAction(input: {
    title: string;
    summary: ReactNode;
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
      summary: input.summary,
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
        setNotice(describeOutcome(t, input.kind, input.ids, result));
        setSelected(new Set());
        await load({ ...query, cursor: "" });
      },
    });
  }

  const initiallyLoading = !data && loading;
  const filtered = isDeadLetterQueryFiltered(query);
  return (
    <section aria-labelledby="dead-letter-workspace-title" className="space-y-5">
      <div id="dead-letter-workspace-title">
        <PageHeader purpose={t("Triage failed and blocked generation requests, then requeue or discard them through audited authority commands.")} title={t("Dead-letter")} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status">
        <span>{freshnessLabel(t, locale, data, loading, error, refreshedAt)}</span>
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

      {error ? <AuthorityError hasSnapshot={Boolean(data)} message={error} onRetry={() => void load(query)} /> : null}
      {initiallyLoading ? <Loading /> : data ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 py-3">
            <label className="flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
              <input aria-label={t("Select all dead-letter jobs")} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rowIds))} type="checkbox" />

              {t("Select all")}
            </label>
            <span className="text-xs text-[var(--ad-text-muted)]">{t("{count} selected", { count: selectedIds.length })}</span>
            <div className="ml-auto flex gap-2">
              {permissions.requeue ? <ActionButton
                count={selectedRequeueIds.length}
                disabled={selectedRequeueIds.length === 0}
                icon={<RefreshCcw className="h-4 w-4" />}
                label={t("Requeue selected")}
                onClick={() => requestAction({
                  allowed: permissions.requeue,
                  title: t("Requeue {count} requests", { count: selectedRequeueIds.length }),
                  summary: <RequeueSummary count={selectedRequeueIds.length} skipped={selectedIds.length - selectedRequeueIds.length} />,
                  endpoint: "/api/v2/admin/generation/dead-letter/commands/requeue",
                  ids: selectedRequeueIds,
                  kind: "requeue",
                  reasonRequired: true,
                })}
              /> : null}
              {permissions.discard ? <ActionButton
                count={selectedDiscardIds.length}
                danger
                disabled={selectedDiscardIds.length === 0}
                icon={<Trash2 className="h-4 w-4" />}
                label={t("Discard selected")}
                onClick={() => requestAction({
                  allowed: permissions.discard,
                  title: t("Discard {count} requests", { count: selectedDiscardIds.length }),
                  summary: <DiscardSummary count={selectedDiscardIds.length} skipped={selectedIds.length - selectedDiscardIds.length} />,
                  endpoint: "/api/v2/admin/generation/dead-letter/commands/discard",
                  ids: selectedDiscardIds,
                  kind: "discard",
                  reasonRequired: true,
                })}
              /> : null}
            </div>
          </div>
          {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} ref={noticeRef} /> : null}
          {rows.length === 0 ? <EmptyState action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={() => navigate(defaultDeadLetterQuery)} type="button">{t("Clear filters")}</button> : undefined} hint={t(filtered ? "The complete dead-letter authority query returned no matches." : "No failed or blocked generation requests require triage.")} title={t(canonicalListEmptyTitle("dead_letter", filtered))} /> : (
            // SEAM: 手写表——`DataTable` 目前不支持多选。多选能力落地后整表迁过去，
            // 届时这里只剩 cells 映射。别在迁移前又复制一份表格样式出去。
            <div aria-label={t("Dead-letter Queue scrollable table")} className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="region" tabIndex={0}>
              <table className="w-full min-w-[1120px] text-left text-sm">
                <caption className="sr-only">{t("Dead-letter Queue")}</caption>
                <thead><tr className="border-b border-[var(--ad-border)] text-xs uppercase text-[var(--ad-text-muted)]">{["", "Job", "User", "Mode", "Status", "Provider", "Failure reason", "Replay authority", "Ledger", "Cost", "Updated", "Actions"].map((header, index) => <th className="px-3 py-3 font-medium" key={`${header}-${index}`} scope="col">{header ? t(header) : header}</th>)}</tr></thead>
                <tbody>{rows.map((row) => {
                  const id = text(row.id);
                  const verdict = retryVerdict(row.retryEligibility);
                  return <tr className="border-b border-[var(--ad-border)] last:border-0" key={id}>
                    <td className="px-3 py-3"><input aria-label={t("Select dead-letter job {id}", { id })} checked={selected.has(id)} onChange={() => toggle(id)} type="checkbox" /></td>
                    <td className="px-3 py-3 font-mono text-xs"><a className="underline decoration-dotted underline-offset-2 hover:text-[var(--ad-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]" href={`/admin/ops/jobs?job=${encodeURIComponent(id)}`}>{id}</a></td>
                    <td className="px-3 py-3 font-mono text-xs">{text(row.userId)}</td>
                    <td className="px-3 py-3">{enumOr(enumLabel, row.mode)}</td>
                    <td className="px-3 py-3">{enumOr(enumLabel, row.status)}</td>
                    <td className="px-3 py-3">{display(row.provider)}</td>
                    <td className="px-3 py-3">{text(row.errorCode) || "—"}</td>
                    <td className="px-3 py-3"><RetryAuthority verdict={verdict} /></td>
                    <td className="px-3 py-3">{enumOr(enumLabel, row.ledgerState)}</td>
                    <td className="px-3 py-3">{display(row.costDreamcoins)}</td>
                    <td className="px-3 py-3">{date(row.updatedAt, locale)}</td>
                    <td className="px-3 py-3"><div className="flex gap-1">
                      {permissions.requeue && requeueAllowed(row) ? <ActionButton icon={<RefreshCcw className="h-4 w-4" />} label={t("Requeue")} onClick={() => requestAction({
                        allowed: permissions.requeue,
                        title: t("Requeue {id}", { id }),
                        summary: <RequeueSummary count={1} skipped={0} />,
                        endpoint: `/api/v2/admin/generation/dead-letter/${id}/commands/requeue`,
                        ids: [id],
                        kind: "requeue",
                        reasonRequired: false,
                      })} /> : null}
                      {permissions.discard && discardAllowed(row) ? <ActionButton danger icon={<Trash2 className="h-4 w-4" />} label={t("Discard")} onClick={() => requestAction({
                        allowed: permissions.discard,
                        title: t("Discard {id}", { id }),
                        summary: <DiscardSummary count={1} skipped={0} />,
                        endpoint: `/api/v2/admin/generation/dead-letter/${id}/commands/discard`,
                        ids: [id],
                        kind: "discard",
                        reasonRequired: true,
                      })} /> : null}
                      {!permissions.requeue && !permissions.discard ? t("Read only") : null}
                    </div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
          {data.pageInfo?.hasNextPage && data.pageInfo.endCursor ? <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" disabled={loading} onClick={() => navigate({ ...query, cursor: data.pageInfo?.endCursor ?? "" })} type="button"><RefreshCcw className="h-4 w-4" />{t("Next dead-letter page")}</button> : null}
        </>
      ) : null}
      {confirmation ? <ConfirmDialog onClose={() => setConfirmation(null)} spec={confirmation} /> : null}
    </section>
  );
}

function RequeueSummary({ count, skipped }: { count: number; skipped: number }) {
  const { t } = useAdminI18n();
  return (
    <span>
      {t("{count} requests re-enter the generation queue and are charged for a new attempt.", { count })}
      {skipped > 0 ? ` ${t("{count} selected requests the authority will not retry are excluded.", { count: skipped })}` : ""}
    </span>
  );
}

function DiscardSummary({ count, skipped }: { count: number; skipped: number }) {
  const { t } = useAdminI18n();
  return (
    <span>
      {t("Discard settles the customer: any charge that was never refunded is refunded now. {count} requests are affected.", { count })}
      {skipped > 0 ? ` ${t("{count} selected requests the authority will not discard are excluded.", { count: skipped })}` : ""}
    </span>
  );
}

const NoticeBanner = ({ notice, onDismiss, ref }: {
  notice: Notice;
  onDismiss: () => void;
  ref: Ref<HTMLDivElement>;
}) => {
  const { t } = useAdminI18n();
  const tone = notice.tone === "ok"
    ? "bg-[var(--ad-green-bg)] text-[var(--ad-green-text)]"
    : "bg-[var(--ad-yellow-bg)] text-[var(--ad-yellow-text)]";
  return (
    <div className={`flex items-start gap-3 rounded-md p-3 text-sm ${tone}`} data-testid="admin-action-status" ref={ref} role="status" tabIndex={-1}>
      {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0 flex-1">
        <p>{notice.summary}</p>
        {notice.skipped.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {notice.skipped.map((entry) => (
              <li key={entry.id}>
                <code className="font-mono">{entry.id}</code> · {SKIP_LABELS[entry.reason] ? t(SKIP_LABELS[entry.reason]) : `${t("Reason not recognised")} (${entry.reason})`}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <button aria-label={t("Dismiss result")} className="grid min-h-8 min-w-8 place-items-center rounded" onClick={onDismiss} type="button"><X className="h-4 w-4" /></button>
    </div>
  );
};

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
function describeOutcome(
  t: (key: string, values?: Record<string, string | number>) => string,
  kind: "requeue" | "discard",
  requested: readonly string[],
  result: unknown,
): Notice {
  const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  const skipped = readSkipped(record.skipped);
  if (kind === "requeue") {
    const done = readIds(record.requeued) ?? (record.queued === true ? [...requested] : []);
    const attemptNo = typeof record.attemptNo === "number" ? record.attemptNo : null;
    return {
      tone: skipped.length > 0 ? "warn" : "ok",
      summary: attemptNo !== null
        ? t("Requeued {id} as attempt {attemptNo}.", { attemptNo, id: requested[0] ?? "" })
        : t("Requeued {done} of {total} requests.", { done: done.length, total: requested.length }),
      skipped,
    };
  }
  const done = readIds(record.discarded) ?? (record.discarded === true ? [...requested] : []);
  const refunded = readIds(record.refunded) ?? (record.refunded === true ? [...requested] : []);
  return {
    tone: skipped.length > 0 ? "warn" : "ok",
    summary: t("Discarded {done} of {total} requests · {refunded} refunded.", {
      done: done.length,
      refunded: refunded.length,
      total: requested.length,
    }),
    skipped,
  };
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

function freshnessLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  locale: "en" | "zh",
  data: ListResponse | null,
  loading: boolean,
  error: string | null,
  refreshedAt: string | null,
) {
  const time = refreshedAt ? new Date(refreshedAt).toLocaleTimeString(adminDateLocale(locale)) : t("unknown");
  if (loading && data) return t("refreshing · as of {time}", { time });
  if (error && data) return t("stale · last good {time}", { time });
  if (error) return t("unavailable");
  if (data) return t("as of {time}", { time });
  return t("loading…");
}

function AuthorityError({ hasSnapshot, message, onRetry }: { hasSnapshot: boolean; message: string; onRetry: () => void }) {
  const { t } = useAdminI18n();
  return <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{t("Dead-letter authority refresh failed:")} {message}<button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={onRetry} type="button">{t("Retry dead-letter")}</button>{hasSnapshot ? <span className="ml-2">{t("The last good snapshot remains visible.")}</span> : null}</div>;
}

function Loading() {
  const { t } = useAdminI18n();
  return <div aria-label={t("Loading dead-letter queue…")} className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading dead-letter queue…")}</span></div>;
}

function Field({ label, onChange, search = false, value }: { label: string; onChange: (value: string) => void; search?: boolean; value: string }) {
  const { t } = useAdminI18n();
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} role={search ? "searchbox" : undefined} value={value} /></label>;
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string }) {
  const { t, value: enumLabel } = useAdminI18n();
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{t(label)}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option ? enumLabel(option) : t("All")}</option>)}</select></label>;
}

function ActionButton({ count, danger = false, disabled = false, icon, label, onClick }: { count?: number; danger?: boolean; disabled?: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={`inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)] disabled:opacity-40 ${danger ? "text-[var(--ad-red-text)]" : "text-[var(--ad-text)]"}`} disabled={disabled} onClick={onClick} type="button">{icon}{label}{count === undefined ? null : <span className="font-mono text-xs">({count})</span>}</button>;
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function display(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : "—"; }
// SEAM: `text`/`display`/`date` 在 12 个工作台里几乎逐字重复；共享 `ui/format.ts` 正在建，落地后删掉本地这三个。
function date(value: unknown, locale: "en" | "zh") { const parsed = new Date(text(value)); return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString(adminDateLocale(locale)); }

// 枚举值走 value()/zhValues 通道，不进 t() 词表。
function enumOr(enumLabel: (key: string) => string, value: unknown) {
  return typeof value === "string" && value ? enumLabel(value) : display(value);
}
