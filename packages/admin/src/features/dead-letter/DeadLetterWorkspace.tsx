"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCcw, Trash2, X } from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { ConfirmDialog, type ConfirmSpec } from "@/components/admin/ui/ConfirmDialog";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
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

export function DeadLetterWorkspace({ permissions }: { permissions: { requeue: boolean; discard: boolean } }) {
  const { t } = useAdminI18n();
  const [query, setQuery] = useState<DeadLetterQuery>(() => currentQuery());
  const [draft, setDraft] = useState<DeadLetterQuery>(() => currentQuery());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    endpoint: string;
    ids: string[];
    reasonRequired: boolean;
    methodLabel: string;
    allowed: boolean;
  }) {
    if (!input.allowed || input.ids.length === 0) return;
    const expected = deadLetterConfirmation(input.ids);
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: input.title,
      summary: <span>{input.ids.length}  {t("generation request")}{input.ids.length === 1 ? "" : "s"}  {t("· authority confirmation required")}</span>,
      destructive: { expectedName: expected, inputLabel: "Confirmation" },
      requireReason: input.reasonRequired,
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        const isBatch = input.endpoint.includes("/dead-letter/");
        await apiWrite(input.endpoint, "POST", isBatch
          ? { jobIds: input.ids, reason, confirmation: expected }
          : { ...(reason ? { reason } : {}), confirmation: expected }, {
          "idempotency-key": idempotencyKey,
        });
        setNotice(`${input.methodLabel} completed.`);
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
        <PageHeader purpose="Triage failed and blocked generation requests, then requeue or discard them through audited authority commands." title={t("Dead-letter Queue")} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ad-text-muted)]" role="status">
        <span>{t("Legacy compatibility authority · source freshness watermark unavailable ·")} {freshnessLabel(data, loading, error, refreshedAt)}</span>
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
          <button className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white" type="submit">{t("Apply")}</button>
          {filtered ? <button aria-label={t("Clear dead-letter filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={() => navigate(defaultDeadLetterQuery)} type="button"><X className="h-4 w-4" /></button> : null}
        </div>
      </form>

      {notice ? <p className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]" data-testid="admin-action-status" role="status">{notice}</p> : null}
      {error ? <AuthorityError hasSnapshot={Boolean(data)} message={error} onRetry={() => void load(query)} /> : null}
      {initiallyLoading ? <Loading /> : data ? (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 py-3">
            <label className="flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
              <input aria-label={t("Select all dead-letter jobs")} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rowIds))} type="checkbox" />

              {t("Select all")}
            </label>
            <span className="text-xs text-[var(--ad-text-muted)]">{selectedIds.length}  {t("selected")}</span>
            <div className="ml-auto flex gap-2">
              {permissions.requeue ? <ActionButton disabled={selectedIds.length === 0} icon={<RefreshCcw className="h-4 w-4" />} label="Requeue selected" onClick={() => requestAction({ allowed: permissions.requeue, title: `Requeue ${selectedIds.length} jobs`, endpoint: "/api/v1/admin/generation/dead-letter/requeue", ids: selectedIds, reasonRequired: true, methodLabel: `Requeue ${selectedIds.length} jobs` })} /> : null}
              {permissions.discard ? <ActionButton danger disabled={selectedIds.length === 0} icon={<Trash2 className="h-4 w-4" />} label="Discard selected" onClick={() => requestAction({ allowed: permissions.discard, title: `Discard ${selectedIds.length} jobs`, endpoint: "/api/v1/admin/generation/dead-letter/discard", ids: selectedIds, reasonRequired: true, methodLabel: `Discard ${selectedIds.length} jobs` })} /> : null}
            </div>
          </div>
          {rows.length === 0 ? <EmptyState action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={() => navigate(defaultDeadLetterQuery)} type="button">{t("Clear filters")}</button> : undefined} hint={filtered ? "The complete dead-letter authority query returned no matches." : "No failed or blocked generation requests require triage."} title={filtered ? "No dead-letter jobs match these filters" : "No dead-letter jobs"} /> : (
            <div aria-label={t("Dead-letter Queue scrollable table")} className="overflow-x-auto rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="region" tabIndex={0}>
              <table className="w-full min-w-[980px] text-left text-sm">
                <caption className="sr-only">{t("Dead-letter Queue")}</caption>
                <thead><tr className="border-b border-[var(--ad-border)] text-xs uppercase text-[var(--ad-text-muted)]">{["", "Job", "User", "Mode", "Status", "Failure reason", "Ledger", "Cost", "Updated", "Actions"].map((header, index) => <th className="px-3 py-3 font-medium" key={`${header}-${index}`} scope="col">{header}</th>)}</tr></thead>
                <tbody>{rows.map((row) => {
                  const id = text(row.id);
                  const status = text(row.status);
                  return <tr className="border-b border-[var(--ad-border)] last:border-0" key={id}>
                    <td className="px-3 py-3"><input aria-label={t("Select dead-letter job {id}", { id })} checked={selected.has(id)} onChange={() => toggle(id)} type="checkbox" /></td>
                    <td className="px-3 py-3 font-mono text-xs">{id}</td>
                    <td className="px-3 py-3 font-mono text-xs">{text(row.userId)}</td>
                    <td className="px-3 py-3">{display(row.mode)}</td>
                    <td className="px-3 py-3">{display(row.status)}</td>
                    <td className="px-3 py-3">{text(row.errorCode) || "—"}</td>
                    <td className="px-3 py-3">{display(row.ledgerState)}</td>
                    <td className="px-3 py-3">{display(row.costDreamcoins)}</td>
                    <td className="px-3 py-3">{date(row.updatedAt)}</td>
                    <td className="px-3 py-3"><div className="flex gap-1">
                      {permissions.requeue && status === "failed" ? <ActionButton icon={<RefreshCcw className="h-4 w-4" />} label="Requeue" onClick={() => requestAction({ allowed: permissions.requeue, title: `Requeue ${id}`, endpoint: `/api/v1/admin/generation/jobs/${id}/requeue`, ids: [id], reasonRequired: false, methodLabel: `Requeue ${id}` })} /> : null}
                      {permissions.discard && (status === "failed" || status === "blocked") ? <ActionButton danger icon={<Trash2 className="h-4 w-4" />} label="Discard" onClick={() => requestAction({ allowed: permissions.discard, title: `Discard ${id}`, endpoint: `/api/v1/admin/generation/jobs/${id}/discard`, ids: [id], reasonRequired: true, methodLabel: `Discard ${id}` })} /> : null}
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

function restoreFromUrl(load: (query: DeadLetterQuery) => Promise<void>, setQuery: (query: DeadLetterQuery) => void, setDraft: (query: DeadLetterQuery) => void) {
  const restored = currentQuery();
  setQuery(restored);
  setDraft(restored);
  void load(restored);
}

function currentQuery() {
  return typeof window === "undefined" ? defaultDeadLetterQuery : deadLetterQueryFromSearch(window.location.search);
}

function freshnessLabel(data: ListResponse | null, loading: boolean, error: string | null, refreshedAt: string | null) {
  const time = refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : "unknown";
  if (loading && data) return `refreshing · showing snapshot from ${time}`;
  if (error && data) return `stale · last good ${time}`;
  if (error) return "unavailable";
  if (data) return `current client snapshot · ${time}`;
  return "refreshing · no snapshot yet";
}

function AuthorityError({ hasSnapshot, message, onRetry }: { hasSnapshot: boolean; message: string; onRetry: () => void }) {
  const { t } = useAdminI18n();
  return <div className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{t("Dead-letter authority refresh failed:")} {message}<button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={onRetry} type="button">{t("Retry dead-letter")}</button>{hasSnapshot ? <span className="ml-2">{t("The last good snapshot remains visible.")}</span> : null}</div>;
}

function Loading() {
  const { t } = useAdminI18n();
  return <div aria-label={t("Loading dead-letter authority")} className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4" role="status"><span className="inline-flex items-center gap-2 text-sm text-[var(--ad-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading dead-letter authority")}</span></div>;
}

function Field({ label, onChange, search = false, value }: { label: string; onChange: (value: string) => void; search?: boolean; value: string }) {
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} role={search ? "searchbox" : undefined} value={value} /></label>;
}

function Select({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: string[]; value: string }) {
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<select className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm" onChange={(event) => onChange(event.target.value)} value={value}>{options.map((option) => <option key={option || "all"} value={option}>{option || "All"}</option>)}</select></label>;
}

function ActionButton({ danger = false, disabled = false, icon, label, onClick }: { danger?: boolean; disabled?: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={`inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm disabled:opacity-40 ${danger ? "text-[var(--ad-red-text)]" : "text-[var(--ad-text)]"}`} disabled={disabled} onClick={onClick} type="button">{icon}{label}</button>;
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function display(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : "—"; }
function date(value: unknown) { const parsed = new Date(text(value)); return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString(); }
