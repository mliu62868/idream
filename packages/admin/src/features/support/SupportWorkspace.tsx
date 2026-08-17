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
import { GhostButton } from "@/components/admin/ui/buttons";
import { StatusPill } from "@/components/admin/ui/StatusPill";
import { adminV2Request } from "@/lib/admin-v2-api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { useAdminFormat } from "@/components/admin/ui/format";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { emptyPageInfo, Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useFailureToast, useToast } from "@/components/admin/ui/Toast";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  defaultSupportQuery,
  SUPPORT_PAGE_SIZE,
  supportListPath,
  supportQueryFromSavedState,
  supportQueryFromSearch,
  supportSavedState,
  supportWorkspaceUrl,
  type SupportQuery,
} from "./query";

type Row = Record<string, unknown>;
type AdminFormat = ReturnType<typeof useAdminFormat>;
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
  const format = useAdminFormat();
  const { toast } = useToast();
  const failureToast = useFailureToast();
  // INVARIANT: the server render and first client render use the same state.
  // URL-owned filters are restored only after hydration (the mount effect below
  // calls `restore()`, so a shared link opens on the filters it encodes).
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
  // SPEC: 「上一页」走自己走过的游标回头，不给后端发 `before`。
  // INTENT: 支持工单列表还是单向 keyset（响应里没有 startCursor / hasPreviousPage），
  //         把 startCursor 塞进 `before` 会被 .strict() 挡成 400。翻页栈是本地的，
  //         所以第一页时 hasPrevious 为假 —— 置灰，而不是给一个点了会报错的按钮。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
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
      setCursorTrail([]);
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

  function navigate(
    next: SupportQuery,
    mode: "push" | "replace" = "push",
    trail: string[] = [],
  ) {
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
    setCursorTrail(trail);
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
  const pageInfo = data?.pageInfo ?? emptyPageInfo;
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
          {freshness(data, loading, error, refreshedAt ? format.time(refreshedAt) : null)}
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
          action={
            filtered ? (
              <GhostButton onClick={() => navigate(defaultSupportQuery)}>
                {t("Clear filters")}
              </GhostButton>
            ) : null
          }
          hint={
            filtered
              ? t("These filters match nothing right now. Clearing them shows every request.")
              : t("The complete support authority query returned no requests.")
          }
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
            "Escalation",
            "Assigned",
            "Last update",
            "Resolution",
            "Created",
            "Actions",
          ]}
          minimumWidthClassName="min-w-[2000px]"
          rows={supportRows(rows, canWrite, confirmAction, format)}
          stickyLastColumn
        />
      ) : null}
      {data && rows.length > 0 ? (
        <Pagination
          hasNext={Boolean(pageInfo.hasNextPage && pageInfo.endCursor)}
          hasPrevious={cursorTrail.length > 0}
          loading={loading}
          onNext={() => {
            if (!pageInfo.endCursor) return;
            navigate({ ...query, cursor: pageInfo.endCursor }, "push", [...cursorTrail, query.cursor]);
          }}
          onPrevious={() =>
            navigate({ ...query, cursor: cursorTrail.at(-1) ?? "" }, "push", cursorTrail.slice(0, -1))
          }
          page={cursorTrail.length + 1}
          pageSize={SUPPORT_PAGE_SIZE}
          rowCount={rows.length}
        />
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
  format: AdminFormat,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = format.text(row.ticketId);
    const status = format.text(row.status);
    const sla = format.text(row.slaState);
    const escalated = Boolean(format.text(row.slaEscalatedAt));
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
        format.display(row.userEmail),
        format.display(row.category),
        format.display(row.subject),
        <CaseText key="description" value={format.text(row.description)} />,
        status,
        format.display(row.priority),
        <SlaCell
          dueAt={format.text(row.slaDueAt)}
          hoursRemaining={
            typeof row.slaHoursRemaining === "number"
              ? row.slaHoursRemaining
              : null
          }
          key="sla"
          state={sla}
        />,
        <EscalationCell
          at={format.text(row.slaEscalatedAt)}
          key="escalation"
          reason={format.text(row.slaEscalationReason)}
        />,
        format.display(row.assignedToEmail),
        // SPEC: 工单上一次动过是什么时候。
        // INTENT: 「卡了多久」是客服排队的首要依据，而权威接口一直返回 updatedAt，
        //         工作台以前只画 createdAt——于是一条刚回过的工单和一条躺了两周的长得一样。
        <LastUpdateCell key="updated" value={format.text(row.updatedAt)} />,
        format.display(row.resolutionNotes),
        format.dateTime(row.createdAt),
        canWrite ? (
          <div className="flex flex-wrap gap-1">
            {actions.map((action) => (
              <TicketAction
                icon={action.icon}
                key={`${id}-${action.label}`}
                label={action.label}
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
              />
            ))}
          </div>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}

function TicketAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const { t } = useAdminI18n();
  return (
    <button
      className="inline-flex min-h-9 items-center gap-1 rounded border px-2"
      onClick={onClick}
      type="button"
    >
      {icon}
      {t(label)}
    </button>
  );
}

// SPEC: SLA 一格说清三件事：状态、还剩/已逾期多久、截止时刻。
// INTENT: 以前「SLA」列是一个状态词、「Due」列是一个绝对时间戳，客服要自己拿当前时间做减法
//         才知道急不急。剩余小时数是服务端算好一起发过来的（priority→小时表），只是没人画。
// INVARIANT: hoursRemaining 为 null 时不编一个倒计时——paused / closed 本来就没有截止。
function SlaCell({
  dueAt,
  hoursRemaining,
  state,
}: {
  dueAt: string;
  hoursRemaining: number | null;
  state: string;
}) {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  return (
    <span className="block">
      {/* 基调走 slaTone 映射，文字仍是 SLA 状态本身 —— 别让 pill 显示映射后的词。 */}
      <StatusPill label={state ? value(state) : "—"} status={slaTone(state)} />
      {hoursRemaining === null ? null : (
        <span className="mt-1 block text-xs font-semibold">
          {hoursRemaining < 0
            ? t("Overdue by {hours}h", { hours: Math.abs(hoursRemaining) })
            : t("{hours}h left", { hours: hoursRemaining })}
        </span>
      )}
      {dueAt ? (
        <span className="block text-xs text-[var(--ad-text-muted)]">
          {format.dateTime(dueAt)}
        </span>
      ) : null}
    </span>
  );
}

// INTENT: SLA 状态词不在 status-tone 的表里（它认的是 approved/failed 这类），
//         这里把四个 SLA 状态映射到已有的基调词，而不是再造一套颜色。
function slaTone(state: string) {
  if (state === "overdue") return "failed";
  if (state === "due_soon") return "pending";
  if (state === "on_track") return "active";
  if (state === "paused") return "paused";
  return state || "archived";
}

function EscalationCell({ at, reason }: { at: string; reason: string }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  if (!at) return <span className="text-[var(--ad-text-muted)]">{t("Not escalated")}</span>;
  return (
    <span className="block">
      <span className="block text-xs font-semibold">{format.dateTime(at)}</span>
      <span className="block max-w-[16rem] break-words text-xs text-[var(--ad-text-muted)]">
        {reason || t("No reason recorded")}
      </span>
    </span>
  );
}

function LastUpdateCell({ value }: { value: string }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  if (!value) return <span className="text-[var(--ad-text-muted)]">{t("Never updated")}</span>;
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  return (
    <span className="block">
      <span className="block">{format.dateTime(value)}</span>
      {Number.isFinite(days) && days >= 1 ? (
        <span className="block text-xs text-[var(--ad-text-muted)]">
          {t("{days}d ago", { days })}
        </span>
      ) : null}
    </span>
  );
}

// SPEC: 工单正文。短的摊开，长的折起来但保留开头。
// INTENT: 描述以前整段塞进单元格，一条长工单能把行高撑满一屏，扫队列变成了滚屏。
function CaseText({ value }: { value: string }) {
  const { t } = useAdminI18n();
  if (!value.trim())
    return <span className="text-[var(--ad-text-muted)]">{t("Nothing written")}</span>;
  if (value.length <= 90)
    return <span className="block max-w-xs break-words">{value}</span>;
  return (
    <details className="max-w-xs">
      <summary
        aria-label={t("Support description")}
        className="cursor-pointer rounded break-words focus-visible:outline focus-visible:outline-2"
      >
        {`${value.slice(0, 90)}…`}
      </summary>
      <p className="mt-2 break-words whitespace-pre-wrap text-xs">{value}</p>
    </details>
  );
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
  const { t } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      {/* aria-label 保持英文原串：mounted 测试与运营脚本按它定位控件，翻译后会一起断。 */}
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
  const { t, value: enumLabel } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      <select
        aria-label={label}
        className="min-h-10 rounded-md border px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {enumLabel(option)}
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
  time: string | null,
) {
  if (loading && data) return `refreshing · as of ${time ?? "unknown"}`;
  if (error && data) return `stale · last good ${time ?? "unknown"}`;
  if (error) return "unavailable";
  if (data) return `current snapshot · ${time ?? "unknown"}`;
  return "loading…";
}
