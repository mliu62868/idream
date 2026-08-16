"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw, Search, X } from "lucide-react";
import type { AdminCommandStatus } from "@idream/shared/admin";
import { apiGet } from "@/components/admin/api";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  auditCommandPath,
  auditListPath,
  auditQueryFromSearch,
  auditWorkspaceUrl,
  defaultAuditQuery,
  isAuditQueryFiltered,
  type AuditQuery,
} from "./query";

type AuditRecord = Record<string, unknown>;
type AuditListResponse = {
  items: AuditRecord[];
  pageInfo?: AuditPageInfo;
};

type AuditPageInfo = { endCursor: string | null; hasNextPage: boolean };
const emptyPageInfo: AuditPageInfo = { endCursor: null, hasNextPage: false };

export function AuditWorkspace() {
  const { t } = useAdminI18n();
  const [query, setQuery] = useState<AuditQuery>(() => currentQuery());
  const [draft, setDraft] = useState<AuditQuery>(() => currentQuery());
  const [rows, setRows] = useState<AuditRecord[] | null>(null);
  const [pageInfo, setPageInfo] = useState(emptyPageInfo);
  const [command, setCommand] = useState<AdminCommandStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const requestGate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: AuditQuery) => {
    const request = requestGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const [audit, commandContext] = await Promise.all([
        apiGet<AuditListResponse>(auditListPath(next)),
        next.commandId
          ? apiGet<AdminCommandStatus>(auditCommandPath(next.commandId))
          : Promise.resolve(null),
      ]);
      if (!request.isCurrent()) return;
      setRows(audit.items);
      setPageInfo(audit.pageInfo ?? emptyPageInfo);
      setCommand(commandContext);
      setRefreshedAt(new Date().toISOString());
    } catch (loadError) {
      if (request.isCurrent()) {
        setError(loadError instanceof Error ? loadError.message : "Audit authority request failed");
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const gate = requestGate.current;
    void load(initialQuery.current);
    const restore = () => {
      const restored = currentQuery();
      setQuery(restored);
      setDraft(restored);
      void load(restored);
    };
    window.addEventListener("popstate", restore);
    return () => {
      gate.invalidate();
      window.removeEventListener("popstate", restore);
    };
  }, [load]);

  function navigate(next: AuditQuery, mode: "push" | "replace" = "push") {
    const updates = {
      auditSearch: next.search || null,
      auditAction: next.action || null,
      auditActor: next.actorId || null,
      auditTargetType: next.targetType || null,
      auditCursor: next.cursor || null,
    };
    const url = auditWorkspaceUrl(window.location.pathname, window.location.search, updates);
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    setQuery(next);
    setDraft(next);
    void load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  function clearFilters() {
    navigate({ ...defaultAuditQuery, commandId: query.commandId });
  }

  function nextPage() {
    if (!pageInfo.endCursor) return;
    navigate({ ...query, cursor: pageInfo.endCursor });
  }

  const filtered = isAuditQueryFiltered(query);

  return (
    <section aria-labelledby="audit-workspace-title" className="space-y-5">
      <div id="audit-workspace-title">
        <PageHeader
          purpose="Trace consequential operator decisions to the actor, target, reason, request, and command evidence that produced them."
          title={t("Audit Log")}
        />
      </div>
      <p className="text-xs text-[var(--ad-text-muted)]" role="status">

        {refreshedAt ? <>{t("Refreshed")} <time dateTime={refreshedAt}>{new Date(refreshedAt).toLocaleTimeString()}</time></> : null}
      </p>

      <form className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_repeat(3,minmax(150px,0.7fr))_auto]" onSubmit={apply}>
        <AuditField label="Search audit log" onChange={(search) => setDraft((current) => ({ ...current, search }))} placeholder={t("action, target, reason, or request")} value={draft.search} />
        <AuditField label="Exact action" onChange={(action) => setDraft((current) => ({ ...current, action }))} placeholder={t("character.release.publish")} value={draft.action} />
        <AuditField label="Actor ID" onChange={(actorId) => setDraft((current) => ({ ...current, actorId }))} placeholder={t("operator ID")} value={draft.actorId} />
        <AuditField label="Target type" onChange={(targetType) => setDraft((current) => ({ ...current, targetType }))} placeholder={t("character_release")} value={draft.targetType} />
        <div className="flex items-end gap-2">
          <button className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={loading} type="submit"><Search className="h-4 w-4" />{t("Apply")}</button>
          {filtered ? <button aria-label={t("Clear audit filters")} className="grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--ad-border)]" onClick={clearFilters} type="button"><X className="h-4 w-4" /></button> : null}
        </div>
      </form>

      {error ? <div className="rounded-md bg-[var(--ad-red-bg)] px-4 py-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}<button className="ml-3 min-h-8 rounded border border-current px-2 font-semibold" onClick={() => void load(query)} type="button">{t("Retry")}</button></div> : null}

      {command ? <CommandContext command={command} /> : null}
      {loading && rows === null ? <AuditLoading /> : rows?.length === 0 ? (
        <EmptyState
          action={filtered ? <button className="min-h-11 rounded-md border border-[var(--ad-border)] px-4 text-sm font-semibold" onClick={clearFilters} type="button">{t("Clear filters")}</button> : undefined}
          hint={filtered ? "The complete server-side query returned no records. Clear filters to inspect the authority." : "Auditable operator actions will appear after the first consequential command is recorded."}
          title={canonicalListEmptyTitle("audit", filtered)}
        />
      ) : rows ? <AuditRecords rows={rows} /> : null}

      {pageInfo.hasNextPage && pageInfo.endCursor ? (
        <button className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-4 text-sm font-semibold disabled:opacity-50" disabled={loading} onClick={nextPage} type="button"><RefreshCcw className="h-4 w-4" />{t("Next page")}</button>
      ) : null}
    </section>
  );
}

function AuditField({ label, onChange, placeholder, value }: { label: string; onChange: (value: string) => void; placeholder: string; value: string }) {
  return <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">{label}<input className="min-h-11 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm text-[var(--ad-text)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} /></label>;
}

function CommandContext({ command }: { command: AdminCommandStatus }) {
  return <DataTable caption="Command context" headers={["Command", "Type", "Target", "Execution", "Verification", "Reconciliation", "Updated"]} rows={[{ id: command.commandId, cells: [<code key="id">{command.commandId}</code>, command.commandType, `${command.target.type}:${command.target.id}`, command.status, command.verificationState ?? "pending", command.needsReconciliation ? "required" : "not required", <time dateTime={command.updatedAt} key="updated">{formatDate(command.updatedAt)}</time>] }]} />;
}

function AuditRecords({ rows }: { rows: AuditRecord[] }) {
  const tableRows: DataTableRow[] = rows.map((row, index) => ({
    id: text(row.id) || `audit-${index}`,
    cells: [
      <code key="id">{text(row.id) || "—"}</code>,
      text(row.actorId) || "system",
      text(row.actorRole) || "—",
      text(row.action) || "—",
      `${text(row.targetType) || "—"}:${text(row.targetId) || "—"}`,
      display(row.reason),
      dateCell(row.createdAt),
    ],
  }));
  return <DataTable caption="Audit authority events" headers={["Event", "Actor", "Role", "Action", "Target", "Reason", "Occurred"]} rows={tableRows} />;
}

function AuditLoading() {
  const { t } = useAdminI18n();
  return <div aria-label={t("Loading audit log…")} className="overflow-hidden rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" role="status"><span className="sr-only">{t("Loading audit log…")}</span>{[0, 1, 2, 3].map((row) => <div className="grid min-h-14 animate-pulse grid-cols-4 gap-4 border-b border-[var(--ad-border)] px-4 py-3 last:border-0" key={row}>{[0, 1, 2, 3].map((cell) => <span className="h-4 rounded bg-black/5" key={cell} />)}</div>)}</div>;
}

function currentQuery() {
  return typeof window === "undefined" ? defaultAuditQuery : auditQueryFromSearch(window.location.search);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function display(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return <code className="block max-w-72 truncate text-xs" title={JSON.stringify(value)}>{JSON.stringify(value)}</code>;
}

function dateCell(value: unknown) {
  const dateTime = text(value);
  return dateTime ? <time dateTime={dateTime}>{formatDate(dateTime)}</time> : "—";
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
