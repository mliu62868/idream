"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { Check, Loader2, RefreshCcw, X } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
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
  approvalListPath,
  approvalQueryFromSearch,
  approvalWorkspaceUrl,
  defaultApprovalQuery,
  type ApprovalQuery,
} from "./query";

type Row = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type ListResponse = { items: Row[]; pageInfo?: PageInfo };

export function ApprovalsWorkspace({ canReview }: { canReview: boolean }) {
  const { t } = useAdminI18n();
  const [query, setQuery] = useState<ApprovalQuery>(() => currentQuery());
  const [draft, setDraft] = useState<ApprovalQuery>(() => currentQuery());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: ApprovalQuery) => {
    const request = gate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ListResponse>(approvalListPath(next));
      if (!request.isCurrent()) return;
      setData(response);
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      if (request.isCurrent()) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Approval authority request failed",
        );
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestGate = gate.current;
    void load(initialQuery.current);
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
  }, [load]);

  function navigate(next: ApprovalQuery, mode: "push" | "replace" = "push") {
    const url = approvalWorkspaceUrl(
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

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  function confirmDecision(id: string, decision: "approve" | "reject") {
    if (!canReview) return;
    const idempotencyKey = crypto.randomUUID();
    const label = decision === "approve" ? "Approve" : "Reject";
    setConfirmation({
      title: `${label} ${id}`,
      destructive: { expectedName: id, inputLabel: "Confirmation" },
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v1/admin/approvals/${id}/${decision}`,
          "POST",
          { reason, confirmation: id },
          { "idempotency-key": idempotencyKey },
        );
        setNotice(`${label} ${id} completed.`);
        navigate({ ...query, cursor: "" }, "replace");
      },
    });
  }

  const filtered = Boolean(query.search || query.status !== "pending");
  const rows = data?.items ?? [];
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Review high-risk requests from the complete approval authority; requester separation and required permissions remain server-enforced."
        title={t("Approvals")}
      />
      <div
        className="flex flex-wrap justify-between gap-2 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <span>

          {t("Approval authority ·")} {freshness(data, loading, error, refreshedAt)}
        </span>
        {!canReview ? (
          <strong>{t("Read only · admin.approval.review is not granted")}</strong>
        ) : null}
      </div>
      <form
        className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-[minmax(280px,1fr)_220px_auto]"
        onSubmit={apply}
      >
        <Field
          label="Search"
          onChange={(search) => setDraft((value) => ({ ...value, search }))}
          value={draft.search}
        />
        <Select
          label="Status"
          onChange={(status) => setDraft((value) => ({ ...value, status }))}
          options={["pending", "approved", "rejected", "canceled"]}
          value={draft.status}
        />
        <div className="flex items-end gap-2">
          <button
            className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
            type="submit"
          >

            {t("Filter approvals")}
          </button>
          {filtered ? (
            <button
              aria-label={t("Clear approval filters")}
              className="grid min-h-11 min-w-11 place-items-center rounded-md border"
              onClick={() => navigate(defaultApprovalQuery)}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </form>
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

          {t("Approval authority refresh failed:")} {error}
          <button
            className="ml-3 min-h-8 rounded border border-current px-2"
            onClick={() => void load(query)}
            type="button"
          >

            {t("Retry approvals")}
          </button>
          {data ? (
            <span className="ml-2">

              {t("The last good snapshot remains visible.")}
            </span>
          ) : null}
        </div>
      ) : null}
      {!data && loading ? (
        <div className="rounded-lg border p-4" role="status">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />

          {t("Loading approval authority")}
        </div>
      ) : data && !rows.length ? (
        <EmptyState
          hint="The complete approval authority query returned no work."
          title={
            filtered
              ? "No approval requests match these filters"
              : "No approval requests are pending"
          }
        />
      ) : data ? (
        <DataTable
          caption="Pending approvals"
          headers={[
            "ID",
            "Action",
            "Permission",
            "Target type",
            "Target",
            "Requester",
            "Reason",
            "Created",
            "Actions",
          ]}
          rows={approvalRows(rows, canReview, confirmDecision)}
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

          {t("Next approval page")}
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

function approvalRows(
  rows: Row[],
  canReview: boolean,
  decide: (id: string, decision: "approve" | "reject") => void,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = text(row.id);
    return {
      id: id || `approval-${index}`,
      cells: [
        id,
        display(row.action),
        display(row.permissionKey),
        display(row.targetType),
        display(row.targetId),
        display(row.requestedById),
        display(row.reason),
        date(row.createdAt),
        canReview ? (
          <div className="flex gap-1">
            <Action
              icon={<Check className="h-4 w-4" />}
              label="Approve"
              onClick={() => decide(id, "approve")}
            />
            <Action
              icon={<X className="h-4 w-4" />}
              label="Reject"
              onClick={() => decide(id, "reject")}
            />
          </div>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}

function Action({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex min-h-9 items-center gap-1 rounded border px-2"
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
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
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        role="searchbox"
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
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
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
    ? defaultApprovalQuery
    : approvalQueryFromSearch(window.location.search);
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
  if (data) return `current client snapshot · ${time}`;
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
