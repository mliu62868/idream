"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { Check, Loader2, X } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { GhostButton } from "@/components/admin/ui/buttons";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { text, useAdminFormat } from "@/components/admin/ui/format";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { emptyPageInfo, Pagination, type PageInfo } from "@/components/admin/ui/Pagination";
import { PermissionNotice } from "@/components/admin/ui/PermissionNotice";
import { useToast } from "@/components/admin/ui/Toast";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  APPROVAL_PAGE_SIZE,
  approvalListPath,
  approvalQueryFromSearch,
  approvalWorkspaceUrl,
  defaultApprovalQuery,
  type ApprovalQuery,
} from "./query";

type Row = Record<string, unknown>;
type AdminFormat = ReturnType<typeof useAdminFormat>;
type ListResponse = { items: Row[]; pageInfo?: PageInfo };

/**
 * SPEC: 一条待审批请求在审批人眼里的完整形状。
 * INTENT: 审批台是双人确认的落点（ADMIN_CONSOLE_PLAN 设计原则 3）。第二个人要挡住的是
 *         「动作对，参数错」——同样是 credit.adjust，+10 和 +1000000 在列表里长得一模一样。
 *         权威接口一直在返回 payload，只是以前没人把它画出来；现在它是审批的主证据。
 */
type ApprovalCase = {
  id: string;
  action: string;
  permissionKey: string;
  targetType: string;
  targetId: string;
  requestedById: string;
  approvedById: string | null;
  reason: string | null;
  payload: Array<[string, string]>;
  createdAt: string;
  decidedAt: string | null;
};

function toApprovalCase(row: Row, index: number): ApprovalCase {
  return {
    id: text(row.id) || `approval-${index}`,
    action: text(row.action),
    permissionKey: text(row.permissionKey),
    targetType: text(row.targetType),
    targetId: text(row.targetId),
    requestedById: text(row.requestedById),
    approvedById: text(row.approvedById) || null,
    reason: text(row.reason) || null,
    payload: payloadEntries(row.payload),
    createdAt: text(row.createdAt),
    decidedAt: text(row.decidedAt) || null,
  };
}

/**
 * INTENT: payload 的形状由发起动作自己决定，运营台无从把它翻成人话——硬编一套「参数名→说明」
 *         的映射就是编造。所以逐字画出键值对：审批人看到的就是将要执行的东西本身。
 */
function payloadEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    typeof entry === "string" ? entry : JSON.stringify(entry) ?? "null",
  ]);
}

export function ApprovalsWorkspace({ canReview }: { canReview: boolean }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const [query, setQuery] = useState<ApprovalQuery>(() => currentQuery());
  const [draft, setDraft] = useState<ApprovalQuery>(() => currentQuery());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCause, setErrorCause] = useState<unknown>(undefined);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  // SPEC: 「上一页」走自己走过的游标回头，不给后端发 `before`。
  // INTENT: 审批列表还是单向 keyset（响应里没有 startCursor / hasPreviousPage）。
  //         翻页栈是本地的，所以第一页时 hasPrevious 为假 —— 置灰而不是给一个会 400 的按钮。
  const [cursorTrail, setCursorTrail] = useState<string[]>([]);
  const gate = useRef(createLatestRequestGate());
  const initialQuery = useRef(query);

  const load = useCallback(async (next: ApprovalQuery) => {
    const request = gate.current.begin();
    setLoading(true);
    setError(null);
    setErrorCause(undefined);
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
        setErrorCause(cause);
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
      setCursorTrail([]);
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

  function navigate(
    next: ApprovalQuery,
    mode: "push" | "replace" = "push",
    trail: string[] = [],
  ) {
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
    setCursorTrail(trail);
    void load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, cursor: "" });
  }

  function confirmDecision(entry: ApprovalCase, decision: "approve" | "reject") {
    if (!canReview) return;
    const id = entry.id;
    const idempotencyKey = crypto.randomUUID();
    const label = decision === "approve" ? "Approve" : "Reject";
    setConfirmation({
      title: t("{action} request {id}", { action: t(label), id }),
      // INTENT: 审批人点「批准」那一刻必须看到自己在放行什么。以前弹窗里只有一个 ID，
      //         要核对参数得先回列表、再横向翻十列——于是没人核对。现在证据跟着决定走。
      summary: <ApprovalImpact entry={entry} />,
      destructive: { expectedName: id, inputLabel: "Confirmation" },
      // INTENT: 审批是终局裁决——后台没有「撤回审批」这条命令，请求方只能重新发起一条。
      consequence: {
        effect:
          decision === "approve"
            ? t("The requested action is released to run and the request leaves this queue. There is no command to withdraw an approval.")
            : t("The request is closed as rejected and leaves this queue. The requester has to raise a new one."),
        reversible: false,
      },
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          `/api/v2/admin/approvals/${id}/${decision}`,
          "POST",
          { reason, confirmation: id },
          { "idempotency-key": idempotencyKey },
        );
        toast({
          tone: "success",
          title:
            decision === "approve"
              ? t("Approved {id}", { id })
              : t("Rejected {id}", { id }),
        });
        navigate({ ...query, cursor: "" }, "replace");
      },
    });
  }

  const filtered = Boolean(query.search || query.status !== "pending");
  const rows = data?.items ?? [];
  const pageInfo = data?.pageInfo ?? emptyPageInfo;
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

          {t("Approval authority ·")}{" "}
          {freshness(data, loading, error, refreshedAt ? format.time(refreshedAt) : null)}
        </span>
        {!canReview ? <PermissionNotice permission="admin.approval.review" /> : null}
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

          {t("Loading approvals…")}
        </div>
      ) : data && !rows.length ? (
        <EmptyState
          action={
            filtered ? (
              <GhostButton onClick={() => navigate(defaultApprovalQuery)}>
                {t("Show pending approvals")}
              </GhostButton>
            ) : null
          }
          hint={
            filtered
              ? t("These filters match nothing right now. Clearing them returns to the pending queue.")
              : t("The complete approval authority query returned no work.")
          }
          title={canonicalListEmptyTitle("approvals", filtered)}
        />
      ) : data ? (
        <DataTable
          caption="Approval requests"
          headers={[
            "ID",
            "Action",
            "Permission",
            "Target",
            "Requested by",
            "Reason",
            "Parameters",
            "Created",
            "Decided",
            "Actions",
          ]}
          minimumWidthClassName="min-w-[1500px]"
          rows={approvalRows(rows, canReview, confirmDecision, format)}
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
          pageSize={APPROVAL_PAGE_SIZE}
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

function approvalRows(
  rows: Row[],
  canReview: boolean,
  decide: (entry: ApprovalCase, decision: "approve" | "reject") => void,
  format: AdminFormat,
): DataTableRow[] {
  return rows.map((row, index) => {
    const entry = toApprovalCase(row, index);
    return {
      id: entry.id,
      cells: [
        entry.id,
        format.display(row.action),
        format.display(row.permissionKey),
        <TargetCell key="target" id={entry.targetId} type={entry.targetType} />,
        format.display(row.requestedById),
        format.display(row.reason),
        <PayloadCell entries={entry.payload} key="payload" />,
        format.dateTime(row.createdAt),
        <DecidedCell
          at={entry.decidedAt}
          by={entry.approvedById}
          key="decided"
        />,
        canReview ? (
          <div className="flex gap-1">
            <Action
              icon={<Check className="h-4 w-4" />}
              label="Approve"
              onClick={() => decide(entry, "approve")}
            />
            <Action
              icon={<X className="h-4 w-4" />}
              label="Reject"
              onClick={() => decide(entry, "reject")}
            />
          </div>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}

function TargetCell({ id, type }: { id: string; type: string }) {
  const { value } = useAdminI18n();
  if (!id && !type) return <>—</>;
  return (
    <span className="block">
      <span className="block text-xs uppercase tracking-[0.05em] text-[var(--ad-text-muted)]">
        {type ? value(type) : "—"}
      </span>
      <span className="block">{id || "—"}</span>
    </span>
  );
}

// SPEC: 列表里参数折起来，标题写「几项」；展开是逐字的键值对。
// INTENT: 十列宽的表格塞不下任意形状的 JSON，但「有没有参数、几项」必须一眼可见——
//         零参数和「有五项没人看」是两种完全不同的风险。
function PayloadCell({ entries }: { entries: Array<[string, string]> }) {
  const { t } = useAdminI18n();
  if (!entries.length)
    return (
      <span className="text-[var(--ad-text-muted)]">
        {t("No parameters")}
      </span>
    );
  return (
    <details className="max-w-xs">
      <summary className="cursor-pointer rounded text-xs underline underline-offset-4 focus-visible:outline focus-visible:outline-2">
        {t("{count} parameters", { count: entries.length })}
      </summary>
      <ParameterList entries={entries} />
    </details>
  );
}

function ParameterList({ entries }: { entries: Array<[string, string]> }) {
  return (
    <dl className="mt-2 grid gap-1 text-xs">
      {entries.map(([key, value]) => (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-2" key={key}>
          <dt className="truncate font-semibold text-[var(--ad-text-muted)]">{key}</dt>
          <dd className="break-words font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DecidedCell({ at, by }: { at: string | null; by: string | null }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  if (!at && !by) return <span className="text-[var(--ad-text-muted)]">{t("Awaiting decision")}</span>;
  return (
    <span className="block">
      <span className="block">{by ?? "—"}</span>
      <span className="block text-xs text-[var(--ad-text-muted)]">{format.dateTime(at)}</span>
    </span>
  );
}

// SPEC: 确认框里的「你正在放行什么」。
// INTENT: 参数在这里不折叠——审批人可以选择不看列表里的折叠项，但不能在没看见参数的情况下
//         走完确认流程。
function ApprovalImpact({ entry }: { entry: ApprovalCase }) {
  const { t, value } = useAdminI18n();
  return (
    <div className="space-y-2">
      <Line label={t("Action")} value={entry.action || "—"} />
      <Line
        label={t("Target")}
        value={`${entry.targetType ? value(entry.targetType) : "—"} · ${entry.targetId || "—"}`}
      />
      <Line label={t("Permission")} value={entry.permissionKey || "—"} />
      <Line label={t("Requested by")} value={entry.requestedById || "—"} />
      <Line label={t("Reason")} value={entry.reason ?? t("No reason given")} />
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.05em]">
          {t("Parameters")}
        </p>
        {entry.payload.length ? (
          <div className="max-h-40 overflow-y-auto">
            <ParameterList entries={entry.payload} />
          </div>
        ) : (
          <p className="mt-1 text-xs">{t("No parameters")}</p>
        )}
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs font-semibold uppercase tracking-[0.05em]">
        {label}
      </span>
      <span className="mt-0.5 block break-words text-sm text-[var(--ad-ink)]">
        {value}
      </span>
    </div>
  );
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
  const { t, value: enumLabel } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      <select
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
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
    ? defaultApprovalQuery
    : approvalQueryFromSearch(window.location.search);
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
  if (data) return `as of ${time ?? "unknown"}`;
  return "loading…";
}
