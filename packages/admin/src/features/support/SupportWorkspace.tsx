"use client";

import {
  AlertTriangle,
  Bookmark,
  Check,
  ClipboardCheck,
  Inbox,
  Loader2,
  MessageSquare,
  RefreshCcw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiWrite } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  defaultSupportQuery,
  supportListPath,
  supportQueryFromSearch,
  supportWorkspaceUrl,
  type SupportQuery,
} from "./query";

type Row = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type ListResponse = {
  items: Row[];
  pageInfo?: PageInfo;
  asOf?: string;
  freshness?: string;
};
type SavedView = {
  id: string;
  label: string;
  filters: unknown;
};
type PlaintextTargetType = "generation_job" | "media";
type PlaintextResult = {
  target: { type: PlaintextTargetType; id: string; ownerId: string };
  plaintext: Record<string, string | null>;
  authorization: { ticketId: string | null; legalHoldId: string | null };
};

const savedViewScope = "support.requests";

export function SupportWorkspace({
  canViewPlaintext,
  canWrite,
}: {
  canViewPlaintext: boolean;
  canWrite: boolean;
}) {
  const [query, setQuery] = useState<SupportQuery>(() => currentQuery());
  const [draft, setDraft] = useState<SupportQuery>(() => currentQuery());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [savedViewLabel, setSavedViewLabel] = useState("");
  const [savedViewError, setSavedViewError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: SupportQuery) => {
    const request = gate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ListResponse>(supportListPath(next));
      if (!request.isCurrent()) return;
      setData(response);
      setRefreshedAt(response.asOf ?? new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Support authority request failed",
        );
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  const loadSavedViews = useCallback(async () => {
    setSavedViewsLoading(true);
    setSavedViewError(null);
    try {
      const response = await apiGet<{ items: SavedView[] }>(
        `/api/v1/admin/saved-views?scope=${encodeURIComponent(savedViewScope)}`,
      );
      setSavedViews(response.items);
    } catch (cause) {
      setSavedViewError(
        cause instanceof Error ? cause.message : "Saved views failed",
      );
    } finally {
      setSavedViewsLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestGate = gate.current;
    void load(initialQuery.current);
    void loadSavedViews();
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      void load(next);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      requestGate.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load, loadSavedViews]);

  useEffect(() => {
    const next = { ...draft, cursor: "" };
    if (sameQuery(next, { ...query, cursor: "" })) return;
    const timer = window.setTimeout(
      () => navigate(next, "replace"),
      draft.search.trim() ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
    // `navigate` intentionally tracks the latest controlled filter draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.search, draft.status, draft.sla, draft.category]);

  function navigate(next: SupportQuery, mode: "push" | "replace" = "push") {
    const url = supportWorkspaceUrl(
      window.location.pathname,
      window.location.search,
      next,
    );
    window.history[mode === "push" ? "pushState" : "replaceState"](
      null,
      "",
      url,
    );
    setQuery(next);
    setDraft(next);
    void load(next);
  }

  function updateDraft(updates: Partial<SupportQuery>) {
    setDraft((value) => ({ ...value, ...updates, cursor: "" }));
  }

  async function saveCurrentView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = savedViewLabel.trim();
    if (!label) return;
    setSavedViewError(null);
    try {
      await apiWrite(
        "/api/v1/admin/saved-views",
        "POST",
        {
          scope: savedViewScope,
          label,
          filters: {
            query: draft.search.trim(),
            status: draft.status,
            sla: draft.sla,
            category: draft.category.trim(),
          },
        },
        { "idempotency-key": crypto.randomUUID() },
      );
      setSavedViewLabel("");
      await loadSavedViews();
    } catch (cause) {
      setSavedViewError(cause instanceof Error ? cause.message : "Save failed");
    }
  }

  async function deleteSavedView(view: SavedView) {
    setSavedViewError(null);
    try {
      await apiDelete(`/api/v1/admin/saved-views/${view.id}`);
      setSavedViews((items) => items.filter((item) => item.id !== view.id));
    } catch (cause) {
      setSavedViewError(
        cause instanceof Error ? cause.message : "Delete failed",
      );
    }
  }

  function applySavedView(view: SavedView) {
    const next = supportQueryFromSavedView(view.filters);
    navigate(next);
  }

  function confirmAction(input: {
    id: string;
    label: string;
    endpoint: string;
    method: "POST" | "PATCH";
    status?: string;
    includeResolution?: boolean;
  }) {
    if (!canWrite) return;
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: `${input.label} ${input.id}`,
      destructive: { expectedName: input.id, inputLabel: "Confirmation" },
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          input.endpoint,
          input.method,
          {
            confirmation: input.id,
            reason,
            resolutionNotes: input.includeResolution ? reason : undefined,
            status: input.status,
          },
          { "idempotency-key": idempotencyKey },
        );
        setNotice(`${input.label} ${input.id} completed.`);
        navigate({ ...query, cursor: "" }, "replace");
      },
    });
  }

  const rows = data?.items ?? [];
  const filtered = Boolean(
    query.search ||
      query.category ||
      query.status !== "all" ||
      query.sla !== "all",
  );
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Triage the complete support request authority with server filters, SLA state, saved views, and audited resolution commands."
        title="Support Requests"
      />
      <div
        className="flex flex-wrap justify-between gap-2 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <span>
          Support authority · {data?.freshness ?? "source freshness pending"} ·{" "}
          {freshness(data, loading, error, refreshedAt)}
        </span>
        <span className="flex gap-3 font-semibold">
          {!canWrite ? (
            <span>Read only · support.request.write is not granted</span>
          ) : null}
          {!canViewPlaintext ? (
            <span>
              Plaintext unavailable · support.plaintext.view is not granted
            </span>
          ) : null}
        </span>
      </div>
      <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
        <div className="grid gap-3 xl:grid-cols-[1fr_160px_160px_160px_300px] xl:items-end">
          <Field
            label="Support search"
            onChange={(search) => updateDraft({ search })}
            value={draft.search}
          />
          <Select
            label="Support status"
            onChange={(status) => updateDraft({ status })}
            options={[
              "all",
              "active",
              "received",
              "open",
              "waiting_on_user",
              "resolved",
              "closed",
            ]}
            value={draft.status}
          />
          <Select
            label="Support SLA"
            onChange={(sla) => updateDraft({ sla })}
            options={[
              "all",
              "overdue",
              "due_soon",
              "on_track",
              "paused",
              "closed",
            ]}
            value={draft.sla}
          />
          <Field
            label="Support category"
            onChange={(category) => updateDraft({ category })}
            value={draft.category}
          />
          <form
            className="grid gap-1"
            onSubmit={(event) => void saveCurrentView(event)}
          >
            <span className="text-xs font-semibold text-[var(--ad-text-muted)]">
              Saved view
            </span>
            <div className="flex gap-2">
              <input
                aria-label="Support saved view label"
                className="min-h-10 min-w-0 flex-1 rounded-md border px-3 text-sm"
                onChange={(event) => setSavedViewLabel(event.target.value)}
                value={savedViewLabel}
              />
              <button
                className="inline-flex min-h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white"
                disabled={!savedViewLabel.trim()}
                type="submit"
              >
                <Bookmark className="h-4 w-4" />
                Save view
              </button>
            </div>
          </form>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {savedViews.map((view) => (
            <span
              className="inline-flex min-h-8 items-center rounded-md border"
              key={view.id}
            >
              <button
                className="h-full px-3 text-xs"
                onClick={() => applySavedView(view)}
                type="button"
              >
                {view.label}
              </button>
              <button
                aria-label={`Delete saved view ${view.label}`}
                className="grid h-8 w-8 place-items-center border-l"
                onClick={() => void deleteSavedView(view)}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {savedViewsLoading ? (
            <span className="text-xs text-[var(--ad-text-muted)]">
              Loading…
            </span>
          ) : null}
          {!savedViewsLoading && !savedViews.length ? (
            <span className="text-xs text-[var(--ad-text-muted)]">
              No saved views.
            </span>
          ) : null}
          {filtered ? (
            <button
              className="min-h-8 rounded-md border px-3 text-xs"
              onClick={() => navigate(defaultSupportQuery)}
              type="button"
            >
              Reset filters
            </button>
          ) : null}
        </div>
        {savedViewError ? (
          <p className="mt-2 text-xs text-[var(--ad-red-text)]" role="alert">
            {savedViewError}
          </p>
        ) : null}
      </section>
      {canViewPlaintext ? <PlaintextAccessPanel /> : null}
      {notice ? (
        <p
          aria-live="polite"
          className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          data-testid="admin-action-status"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <div
          className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          Support authority refresh failed: {error}
          <button
            className="ml-3 min-h-8 rounded border border-current px-2"
            onClick={() => void load(query)}
            type="button"
          >
            Retry support
          </button>
          {data ? (
            <span className="ml-2">
              The last good snapshot remains visible.
            </span>
          ) : null}
        </div>
      ) : null}
      {!data && loading ? (
        <div className="rounded-lg border p-4" role="status">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
          Loading support authority
        </div>
      ) : data && !rows.length ? (
        <EmptyState
          hint="The complete support authority query returned no requests."
          title={
            filtered
              ? "No support requests match these filters"
              : "No support requests exist yet"
          }
        />
      ) : data ? (
        <DataTable
          caption="Support Requests"
          headers={[
            "Ticket",
            "User",
            "Category",
            "Subject",
            "Description",
            "Status",
            "Priority",
            "SLA",
            "Due",
            "Escalation",
            "Assigned",
            "Resolution",
            "Created",
            "Actions",
          ]}
          rows={supportRows(rows, canWrite, confirmAction)}
        />
      ) : null}
      {data?.pageInfo?.hasNextPage && data.pageInfo.endCursor ? (
        <button
          className="inline-flex min-h-11 items-center gap-2 rounded border px-4 text-sm font-semibold"
          disabled={loading}
          onClick={() =>
            navigate({ ...query, cursor: data.pageInfo?.endCursor ?? "" })
          }
          type="button"
        >
          <RefreshCcw className="h-4 w-4" />
          Next support page
        </button>
      ) : null}
      {confirmation ? (
        <ConfirmDialog
          onClose={() => setConfirmation(null)}
          spec={confirmation}
        />
      ) : null}
    </section>
  );
}

function PlaintextAccessPanel() {
  const [targetType, setTargetType] =
    useState<PlaintextTargetType>("generation_job");
  const [targetId, setTargetId] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [legalHoldId, setLegalHoldId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<PlaintextResult | null>(null);
  const [status, setStatus] = useState<{
    good: boolean;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const ready =
    targetId.trim() &&
    reason.trim().length >= 3 &&
    confirmation.trim() === targetId.trim() &&
    (ticketId.trim() || legalHoldId.trim());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || loading) return;
    setLoading(true);
    setStatus(null);
    setResult(null);
    try {
      const response = await apiWrite<PlaintextResult>(
        "/api/v1/admin/support/plaintext/view",
        "POST",
        {
          targetType,
          targetId: targetId.trim(),
          ticketId: ticketId.trim() || undefined,
          legalHoldId: legalHoldId.trim() || undefined,
          reason: reason.trim(),
          confirmation: confirmation.trim(),
        },
        { "idempotency-key": crypto.randomUUID() },
      );
      setResult(response);
      setStatus({ good: true, message: "Plaintext access logged." });
    } catch (cause) {
      setStatus({
        good: false,
        message:
          cause instanceof Error ? cause.message : "Plaintext access failed.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Plaintext access</h2>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">
              Requires active support consent or legal hold.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
            <ShieldCheck className="h-4 w-4" />
            Audit logged
          </span>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <Select
            label="Target type"
            onChange={(value) => setTargetType(value as PlaintextTargetType)}
            options={["generation_job", "media"]}
            value={targetType}
          />
          <Field
            label="Plaintext target ID"
            onChange={setTargetId}
            value={targetId}
          />
          <Field
            label="Consent ticket ID"
            onChange={setTicketId}
            value={ticketId}
          />
          <Field
            label="Legal hold ID"
            onChange={setLegalHoldId}
            value={legalHoldId}
          />
          <Field
            label="Plaintext confirmation"
            onChange={setConfirmation}
            value={confirmation}
          />
          <Field label="Plaintext reason" onChange={setReason} value={reason} />
        </div>
        <button
          className="inline-flex min-h-10 items-center gap-2 bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!ready || loading}
          type="submit"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          View plaintext
        </button>
        {status ? (
          <span
            aria-live="polite"
            className={
              status.good
                ? "ml-3 text-xs text-[var(--ad-green-text)]"
                : "ml-3 text-xs text-[var(--ad-red-text)]"
            }
            data-testid="admin-plaintext-status"
            role="status"
          >
            {status.message}
          </span>
        ) : null}
      </form>
      {result ? (
        <div
          className="mt-4 space-y-3 rounded-lg border bg-black/[0.03] p-3"
          data-testid="admin-plaintext-result"
        >
          <p className="text-xs text-[var(--ad-text-muted)]">
            Target: {result.target.id} · Owner: {result.target.ownerId} ·
            Authorization:{" "}
            {result.authorization.legalHoldId ??
              result.authorization.ticketId ??
              "—"}
          </p>
          {Object.entries(result.plaintext).map(([field, value]) => (
            <div key={field}>
              <p className="text-xs font-semibold">{field}</p>
              <pre className="mt-1 whitespace-pre-wrap text-xs">
                {value || "(empty)"}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

type ConfirmAction = (input: {
  id: string;
  label: string;
  endpoint: string;
  method: "POST" | "PATCH";
  status?: string;
  includeResolution?: boolean;
}) => void;

function supportRows(
  rows: Row[],
  canWrite: boolean,
  confirm: ConfirmAction,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = text(row.ticketId);
    const status = text(row.status);
    const sla = text(row.slaState);
    const escalated = Boolean(text(row.slaEscalatedAt));
    const actions: Array<{
      label: string;
      icon: ReactNode;
      endpoint?: string;
      method?: "POST" | "PATCH";
      next?: string;
      resolution?: boolean;
    }> = [];
    if (
      (sla === "overdue" || sla === "due_soon") &&
      !escalated &&
      status !== "resolved" &&
      status !== "closed"
    )
      actions.push({
        label: "Escalate",
        icon: <AlertTriangle className="h-4 w-4" />,
        endpoint: `/api/v1/admin/support/requests/${id}/escalate`,
        method: "POST",
      });
    if (status === "received")
      actions.push({
        label: "Open",
        icon: <Inbox className="h-4 w-4" />,
        next: "open",
      });
    if (!["waiting_on_user", "resolved", "closed"].includes(status))
      actions.push({
        label: "Waiting",
        icon: <MessageSquare className="h-4 w-4" />,
        next: "waiting_on_user",
      });
    if (!["resolved", "closed"].includes(status))
      actions.push({
        label: "Resolve",
        icon: <ClipboardCheck className="h-4 w-4" />,
        next: "resolved",
        resolution: true,
      });
    if (status !== "closed")
      actions.push({
        label: "Close",
        icon: <Check className="h-4 w-4" />,
        next: "closed",
        resolution: true,
      });
    return {
      id: id || `support-${index}`,
      cells: [
        id,
        display(row.userEmail),
        display(row.category),
        display(row.subject),
        display(row.description),
        status,
        display(row.priority),
        sla,
        date(row.slaDueAt),
        display(row.slaEscalationReason),
        display(row.assignedToEmail),
        display(row.resolutionNotes),
        date(row.createdAt),
        canWrite ? (
          <div className="flex flex-wrap gap-1">
            {actions.map((action) => (
              <button
                className="inline-flex min-h-9 items-center gap-1 rounded border px-2"
                key={`${id}-${action.label}`}
                onClick={() =>
                  confirm({
                    id,
                    label: action.label,
                    endpoint:
                      action.endpoint ?? `/api/v1/admin/support/requests/${id}`,
                    method: action.method ?? "PATCH",
                    status: action.next,
                    includeResolution: action.resolution,
                  })
                }
                type="button"
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}

function supportQueryFromSavedView(value: unknown): SupportQuery {
  if (!value || typeof value !== "object") return defaultSupportQuery;
  const record = value as Record<string, unknown>;
  return {
    search: typeof record.query === "string" ? record.query : "",
    status: typeof record.status === "string" ? record.status : "all",
    sla: typeof record.sla === "string" ? record.sla : "all",
    category: typeof record.category === "string" ? record.category : "",
    cursor: "",
  };
}

function sameQuery(left: SupportQuery, right: SupportQuery) {
  return (
    left.search === right.search &&
    left.status === right.status &&
    left.sla === right.sla &&
    left.category === right.category &&
    left.cursor === right.cursor
  );
}

function Field({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        aria-label={label}
        className="min-h-10 rounded-md border px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function Select({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <select
        aria-label={label}
        className="min-h-10 rounded-md border px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function currentQuery() {
  return typeof window === "undefined"
    ? defaultSupportQuery
    : supportQueryFromSearch(window.location.search);
}

function freshness(
  data: ListResponse | null,
  loading: boolean,
  error: string | null,
  refreshedAt: string | null,
) {
  const time = refreshedAt
    ? new Date(refreshedAt).toLocaleTimeString()
    : "unknown";
  if (loading && data) return `refreshing · showing snapshot from ${time}`;
  if (error && data) return `stale · last good ${time}`;
  if (error) return "unavailable";
  if (data) return `current snapshot · ${time}`;
  return "refreshing · no snapshot yet";
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function display(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "—";
}

function date(value: unknown) {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}
