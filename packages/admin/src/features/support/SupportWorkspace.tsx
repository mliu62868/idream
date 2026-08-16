"use client";

import { useAdminI18n } from "@/components/admin/i18n";
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
import {
  savedViewDeleteSchema,
  savedViewListResponseSchema,
  savedViewMutationResponseSchema,
  type SavedView,
} from "@idream/shared/admin";
import { apiGet, apiWrite } from "@/components/admin/api";
import { adminV2Request } from "@/lib/admin-v2-api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  defaultSupportQuery,
  supportListPath,
  supportQueryFromSavedState,
  supportQueryFromSearch,
  supportSavedState,
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
type PlaintextTargetType = "generation_job" | "media";
type PlaintextResult = {
  target: { type: PlaintextTargetType; id: string; ownerId: string };
  plaintext: Record<string, string | null>;
  authorization: { ticketId: string | null; legalHoldId: string | null };
};

const savedViewScope = "support_request";

export function SupportWorkspace({
  canViewPlaintext,
  canWrite,
}: {
  canViewPlaintext: boolean;
  canWrite: boolean;
}) {
  const { t } = useAdminI18n();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  // INVARIANT: the server render and first client render use the same state.
  // URL-owned filters are restored only after hydration.
  const [query, setQuery] = useState<SupportQuery>(defaultSupportQuery);
  const [draft, setDraft] = useState<SupportQuery>(defaultSupportQuery);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCause, setErrorCause] = useState<unknown>(undefined);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [savedViewLabel, setSavedViewLabel] = useState("");
  const [savedViewError, setSavedViewError] = useState<string | null>(null);
  const [savedViewErrorCause, setSavedViewErrorCause] = useState<unknown>(undefined);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [savingView, setSavingView] = useState(false);
  const gate = useRef(createLatestRequestGate());
  const savedViewCreateKey = useRef<string | null>(null);

  const load = useCallback(async (next: SupportQuery) => {
    const request = gate.current.begin();
    setLoading(true);
    setError(null);
    setErrorCause(undefined);
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
        setErrorCause(cause);
      }
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  const loadSavedViews = useCallback(async () => {
    setSavedViewsLoading(true);
    setSavedViewError(null);
    setSavedViewErrorCause(undefined);
    try {
      const response = await adminV2Request(
        `/api/v2/admin/saved-views?scope=${savedViewScope}`,
        { schema: savedViewListResponseSchema },
      );
      setSavedViews([...response.items]);
    } catch (cause) {
      setSavedViewError(
        cause instanceof Error ? cause.message : "Saved views failed",
      );
      setSavedViewErrorCause(cause);
    } finally {
      setSavedViewsLoading(false);
    }
  }, []);

  useEffect(() => {
    const requestGate = gate.current;
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      void load(next);
    };
    const timer = window.setTimeout(() => {
      void loadSavedViews();
      restore();
    }, 0);
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      window.clearTimeout(timer);
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
    if (!label || savingView) return;
    setSavedViewError(null);
    setSavingView(true);
    try {
      savedViewCreateKey.current ??= crypto.randomUUID();
      await adminV2Request("/api/v2/admin/saved-views", {
        method: "POST",
        idempotencyKey: savedViewCreateKey.current,
        body: { scope: savedViewScope, label, queryState: supportSavedState(draft) },
        schema: savedViewMutationResponseSchema,
      });
      savedViewCreateKey.current = null;
      setSavedViewLabel("");
      toast({ tone: "success", title: t("Saved view {label} created", { label }) });
      await loadSavedViews();
    } catch (cause) {
      // INTENT: 失败时不清 savedViewLabel —— 运营刚敲的名字得留着，重试只差再点一次。
      failureToast(cause);
    } finally {
      setSavingView(false);
    }
  }

  // SPEC: 删除保存视图走确认框并要求敲出视图名。
  // INTENT: 它以前是一个点了就删的垃圾桶图标，误点无法恢复——后台没有回收站。
  function confirmDeleteSavedView(view: SavedView) {
    setConfirmation({
      title: t("Delete saved view {label}", { label: view.label }),
      destructive: { expectedName: view.label, inputLabel: t("Saved view name") },
      consequence: {
        effect: t("The saved view is gone for everyone who uses it. There is no recycle bin."),
        reversible: false,
      },
      // 后端 DELETE 契约没有 reason 字段。
      requireReason: false,
      submitLabel: t("Delete saved view"),
      onSubmit: async () => {
        await adminV2Request(`/api/v2/admin/saved-views/${encodeURIComponent(view.id)}`, {
          method: "DELETE",
          // SPEC: 删除按版本号删 —— 服务端 If-Match 不匹配就 409。
          ifMatch: view.version,
          schema: savedViewDeleteSchema,
        });
        setSavedViews((items) => items.filter((item) => item.id !== view.id));
        toast({ tone: "success", title: t("Saved view {label} deleted", { label: view.label }) });
      },
    });
  }

  function applySavedView(view: SavedView) {
    navigate(supportQueryFromSavedState(view.queryState));
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
      title: t("{action} support request {id}", { action: t(input.label), id: input.id }),
      destructive: { expectedName: input.id, inputLabel: "Confirmation" },
      // INTENT: 支持工单的状态可以再改回去，唯独升级会通知到值班——所以分开说。
      consequence: {
        effect:
          input.label === "Escalate"
            ? t("The on-call rotation is paged and the escalation timestamp is recorded for good.")
            : t("The ticket moves to this status and its SLA clock is recalculated. Another status command moves it back."),
        reversible: input.label !== "Escalate",
      },
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
        toast({ tone: "success", title: t("{action} applied to {id}", { action: input.label, id: input.id }) });
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
        title={t("Support Cases")}
      />
      <div
        className="flex flex-wrap justify-between gap-2 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <span>

          {t("Support authority ·")} {data?.freshness ?? t("source freshness pending")} ·{" "}
          {freshness(data, loading, error, refreshedAt)}
        </span>
        <span className="flex gap-3 font-semibold">
          {!canWrite ? <PermissionNotice permission="support.request.write" /> : null}
          {!canViewPlaintext ? <PermissionNotice permission="support.plaintext.view" /> : null}
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

              {t("Saved view")}
            </span>
            <div className="flex gap-2">
              <input
                aria-label={t("Support saved view label")}
                className="min-h-10 min-w-0 flex-1 rounded-md border px-3 text-sm"
                onChange={(event) => {
                  setSavedViewLabel(event.target.value);
                  savedViewCreateKey.current = null;
                }}
                value={savedViewLabel}
              />
              <button
                className="inline-flex min-h-10 items-center gap-2 bg-[var(--ad-ink)] px-3 text-sm font-semibold text-white"
                disabled={savingView || !savedViewLabel.trim()}
                type="submit"
              >
                {savingView ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bookmark className="h-4 w-4" />}

                {t("Save view")}
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
                aria-label={t("Delete saved view {label}", { label: view.label })}
                className="grid h-8 w-8 place-items-center border-l"
                onClick={() => confirmDeleteSavedView(view)}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          {savedViewsLoading ? (
            <span className="text-xs text-[var(--ad-text-muted)]">

              {t("Loading…")}
            </span>
          ) : null}
          {!savedViewsLoading && !savedViews.length ? (
            <span className="text-xs text-[var(--ad-text-muted)]">

              {t("No saved views.")}
            </span>
          ) : null}
          {filtered ? (
            <button
              className="min-h-8 rounded-md border px-3 text-xs"
              onClick={() => navigate(defaultSupportQuery)}
              type="button"
            >

              {t("Reset filters")}
            </button>
          ) : null}
        </div>
        {savedViewError ? (
          <div className="mt-2">
            <AuthorityRequestError
              cause={savedViewErrorCause}
              message={savedViewError}
              onRetry={() => void loadSavedViews()}
            />
          </div>
        ) : null}
      </section>
      {canViewPlaintext ? <PlaintextAccessPanel /> : null}
      {error ? (
        <AuthorityRequestError
          cause={errorCause}
          message={error}
          onRetry={() => void load(query)}
          snapshotAt={data ? refreshedAt : null}
        />
      ) : null}
      {!data && loading ? (
        <div className="rounded-lg border p-4" role="status">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />

          {t("Loading support requests…")}
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
          minimumWidthClassName="min-w-[2000px]"
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

          {t("Next support page")}
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
  const { t } = useAdminI18n();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  const [targetType, setTargetType] =
    useState<PlaintextTargetType>("generation_job");
  const [targetId, setTargetId] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [legalHoldId, setLegalHoldId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<PlaintextResult | null>(null);
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
    setResult(null);
    try {
      const response = await apiWrite<PlaintextResult>(
        "/api/v2/admin/support/plaintext/view",
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
      toast({ tone: "success", title: t("Plaintext access logged.") });
    } catch (cause) {
      // INTENT: 失败时保留 targetId / reason / confirmation —— 重敲一遍确认串很费事。
      failureToast(cause);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t("Plaintext access")}</h2>
            <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

              {t("Requires active support consent or legal hold.")}
            </p>
          </div>
          <span className="inline-flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
            <ShieldCheck className="h-4 w-4" />

            {t("Audit logged")}
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

          {t("View plaintext")}
        </button>
      </form>
      {result ? (
        <div
          className="mt-4 space-y-3 rounded-lg border bg-black/[0.03] p-3"
          data-testid="admin-plaintext-result"
        >
          <p className="text-xs text-[var(--ad-text-muted)]">

            {t("Target:")} {result.target.id}  {t("· Owner:")} {result.target.ownerId}  {t("· Authorization:")}{" "}
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
        endpoint: `/api/v2/admin/support/requests/${id}/escalate`,
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
                      action.endpoint ?? `/api/v2/admin/support/requests/${id}`,
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
  if (loading && data) return `refreshing · as of ${time}`;
  if (error && data) return `stale · last good ${time}`;
  if (error) return "unavailable";
  if (data) return `current snapshot · ${time}`;
  return "loading…";
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
