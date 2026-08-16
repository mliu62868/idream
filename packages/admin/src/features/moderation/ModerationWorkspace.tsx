"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Image from "next/image";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCheck,
  Loader2,
  RefreshCcw,
  RotateCcw,
  X,
} from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  defaultModerationQuery,
  moderationDecisionConfirmation,
  moderationQueryFromSearch,
  moderationQueuePath,
  moderationWorkspaceUrl,
  type ModerationQuery,
  type ModerationScope,
} from "./query";

type Row = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type QueueResponse = {
  reports?: Row[];
  mediaReview?: Row[];
  appeals?: Row[];
  pageInfo?: Partial<Record<ModerationScope | "mediaReview", PageInfo>>;
};
type AuthorityState = {
  rows: Row[] | null;
  pageInfo: PageInfo;
  error: string | null;
  loading: boolean;
  refreshedAt: string | null;
};
const emptyPageInfo: PageInfo = { endCursor: null, hasNextPage: false };
const emptyState = (): AuthorityState => ({
  rows: null,
  pageInfo: emptyPageInfo,
  error: null,
  loading: true,
  refreshedAt: null,
});

export function ModerationWorkspace({ canDecide }: { canDecide: boolean }) {
  const { t } = useAdminI18n();
  const [query, setQuery] = useState<ModerationQuery>(() => currentQuery());
  const [draft, setDraft] = useState<ModerationQuery>(() => currentQuery());
  const [reports, setReports] = useState<AuthorityState>(emptyState);
  const [media, setMedia] = useState<AuthorityState>(emptyState);
  const [appeals, setAppeals] = useState<AuthorityState>(emptyState);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gates = useRef({
    reports: createLatestRequestGate(),
    media: createLatestRequestGate(),
    appeals: createLatestRequestGate(),
  });
  const initialQuery = useRef(query);

  const loadScope = useCallback(
    async (next: ModerationQuery, scope: ModerationScope) => {
      const gate = gates.current[scope].begin();
      const setter =
        scope === "reports"
          ? setReports
          : scope === "media"
            ? setMedia
            : setAppeals;
      setter((value) => ({ ...value, error: null, loading: true }));
      try {
        const response = await apiGet<QueueResponse>(
          moderationQueuePath(next, scope),
        );
        if (!gate.isCurrent()) return;
        const rows =
          scope === "reports"
            ? (response.reports ?? [])
            : scope === "media"
              ? (response.mediaReview ?? [])
              : (response.appeals ?? []);
        const pageInfo =
          scope === "media"
            ? response.pageInfo?.mediaReview
            : response.pageInfo?.[scope];
        setter({
          rows,
          pageInfo: pageInfo ?? emptyPageInfo,
          error: null,
          loading: false,
          refreshedAt: new Date().toISOString(),
        });
      } catch (cause) {
        if (gate.isCurrent())
          setter((value) => ({
            ...value,
            error:
              cause instanceof Error
                ? cause.message
                : `${scope} authority request failed`,
            loading: false,
          }));
      }
    },
    [],
  );

  const load = useCallback(
    (next: ModerationQuery) => {
      void loadScope(next, "reports");
      void loadScope(next, "media");
      void loadScope(next, "appeals");
    },
    [loadScope],
  );

  useEffect(() => {
    const requestGates = gates.current;
    load(initialQuery.current);
    const restore = () => {
      const next = currentQuery();
      setQuery(next);
      setDraft(next);
      load(next);
    };
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      requestGates.reports.invalidate();
      requestGates.media.invalidate();
      requestGates.appeals.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: ModerationQuery, mode: "push" | "replace" = "push") {
    window.history[mode === "push" ? "pushState" : "replaceState"](
      null,
      "",
      moderationWorkspaceUrl(
        window.location.pathname,
        window.location.search,
        next,
      ),
    );
    setQuery(next);
    setDraft(next);
    load(next);
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, reportCursor: "", mediaCursor: "", appealCursor: "" });
  }

  function confirmDecision(input: {
    kind:
      | "action"
      | "close"
      | "uphold"
      | "overturn"
      | "modify"
      | "media_pass"
      | "media_block";
    id: string;
    endpoint: string;
    method: "POST" | "PATCH";
    payload: (reason: string) => Record<string, unknown>;
    title: string;
  }) {
    if (!canDecide) return;
    const expected = moderationDecisionConfirmation(input.kind, input.id);
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: input.title,
      destructive: { expectedName: expected, inputLabel: "Confirmation" },
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          input.endpoint,
          input.method,
          { ...input.payload(reason), reason, confirmation: expected },
          { "idempotency-key": idempotencyKey },
        );
        setNotice(`${input.title} completed.`);
        navigate(
          { ...query, reportCursor: "", mediaCursor: "", appealCursor: "" },
          "replace",
        );
      },
    });
  }

  const filtered = Boolean(query.search || query.status || query.targetType);
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Review reports, independently pending Character images, blocked media, and appeals from separate authority snapshots; every decision is confirmed, audited, and propagated."
        title={t("Moderation Cases")}
      />
      <div
        className="flex flex-wrap justify-between gap-2 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <div className="flex flex-wrap gap-3">
          <span>

            {t("Legacy compatibility authority · source freshness watermark unavailable")}
          </span>
          <Freshness label="Reports" state={reports} />
          <Freshness label="Media review" state={media} />
          <Freshness label="Appeals" state={appeals} />
        </div>
        {!canDecide ? (
          <strong>{t("Read only · safety.review.write is not granted")}</strong>
        ) : null}
      </div>
      <form
        className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-[minmax(280px,1fr)_200px_200px_auto]"
        onSubmit={apply}
      >
        <Field
          label="Search"
          onChange={(search) => setDraft((value) => ({ ...value, search }))}
          search
          value={draft.search}
        />
        <Select
          label="Report status"
          onChange={(status) => setDraft((value) => ({ ...value, status }))}
          options={["", "open", "triaged", "reviewing", "actioned", "closed"]}
          value={draft.status}
        />
        <Select
          label="Target type"
          onChange={(targetType) =>
            setDraft((value) => ({ ...value, targetType }))
          }
          options={["", "character", "media", "message"]}
          value={draft.targetType}
        />
        <div className="flex items-end gap-2">
          <button
            className="min-h-11 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
            type="submit"
          >

            {t("Apply")}
          </button>
          {filtered ? (
            <button
              aria-label={t("Clear moderation filters")}
              className="grid min-h-11 min-w-11 place-items-center rounded-md border"
              onClick={() => navigate(defaultModerationQuery)}
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
      <AuthorityError
        label="reports"
        onRetry={() => void loadScope(query, "reports")}
        state={reports}
      />
      <AuthorityError
        label="media review"
        onRetry={() => void loadScope(query, "media")}
        state={media}
      />
      <AuthorityError
        label="appeals"
        onRetry={() => void loadScope(query, "appeals")}
        state={appeals}
      />
      <AuthoritySection
        caption="Reports"
        empty={
          filtered
            ? "No reports match these filters"
            : "No reports require review"
        }
        loadingLabel="Loading report authority"
        state={reports}
        rows={reportRows(reports.rows ?? [], canDecide, confirmDecision)}
      />
      <Pager
        cursor="reportCursor"
        label="Next report page"
        loading={reports.loading}
        navigate={navigate}
        pageInfo={reports.pageInfo}
        query={query}
      />
      <AuthoritySection
        caption="Media Review"
        empty={
          query.search
            ? "No media review items match this search"
            : "No Character images await independent review"
        }
        loadingLabel="Loading media-review authority"
        state={media}
        rows={mediaRows(media.rows ?? [], canDecide, confirmDecision, t)}
      />
      <Pager
        cursor="mediaCursor"
        label="Next media-review page"
        loading={media.loading}
        navigate={navigate}
        pageInfo={media.pageInfo}
        query={query}
      />
      <AuthoritySection
        caption="Appeals"
        empty={
          query.search
            ? "No appeals match this search"
            : "No appeals require review"
        }
        loadingLabel="Loading appeal authority"
        state={appeals}
        rows={appealRows(appeals.rows ?? [], canDecide, confirmDecision)}
      />
      <Pager
        cursor="appealCursor"
        label="Next appeal page"
        loading={appeals.loading}
        navigate={navigate}
        pageInfo={appeals.pageInfo}
        query={query}
      />
      {confirmation ? (
        <ConfirmDialog
          onClose={() => setConfirmation(null)}
          spec={confirmation}
        />
      ) : null}
    </section>
  );
}

type ConfirmDecision = (input: {
  kind:
    | "action"
    | "close"
    | "uphold"
    | "overturn"
    | "modify"
    | "media_pass"
    | "media_block";
  id: string;
  endpoint: string;
  method: "POST" | "PATCH";
  payload: (reason: string) => Record<string, unknown>;
  title: string;
}) => void;

function mediaRows(
  rows: Row[],
  canDecide: boolean,
  confirm: ConfirmDecision,
  t: (key: string, values?: Record<string, string | number>) => string,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = text(row.id);
    const characterId = text(row.characterId);
    const safetyStatus = text(row.safetyStatus);
    const pending = safetyStatus === "unknown" || safetyStatus === "flagged";
    const preview = text(row.thumbnailUrl) || text(row.url);
    const action = (
      kind: "media_pass" | "media_block",
      decision: "passed" | "blocked",
      label: string,
      icon: ReactNode,
    ) => (
      <Action
        icon={icon}
        label={label}
        onClick={() =>
          confirm({
            kind,
            id,
            endpoint: `/api/v2/admin/moderation/media/${id}/decision`,
            method: "POST",
            title: t("{action} Character image {id}", { action: label, id }),
            payload: () => ({ decision }),
          })
        }
      />
    );
    return {
      id: id || `media-${index}`,
      cells: [
        preview ? (
          <Image
            alt={t("Character image {id}", { id })}
            className="h-14 w-14 rounded-md border object-cover"
            height={56}
            loading="lazy"
            src={preview}
            unoptimized
            width={56}
          />
        ) : (
          "No preview"
        ),
        id,
        characterId ? (
          <a
            className="underline underline-offset-4"
            href={`/admin/characters/${characterId}?tab=assets`}
          >
            {characterId}
          </a>
        ) : (
          "—"
        ),
        display(row.ownerId),
        safetyStatus || "—",
        text(row.sourceAssetId)
          ? `Duplicate of ${text(row.sourceAssetId)}`
          : display(row.reviewKind),
        date(row.createdAt),
        canDecide && pending ? (
          <div className="flex flex-wrap gap-1">
            {action(
              "media_pass",
              "passed",
              "Approve image",
              <Check className="h-4 w-4" />,
            )}
            {action(
              "media_block",
              "blocked",
              "Block image",
              <X className="h-4 w-4" />,
            )}
          </div>
        ) : canDecide ? (
          "Terminal"
        ) : (
          "Read only"
        ),
      ],
    };
  });
}

function reportRows(
  rows: Row[],
  canDecide: boolean,
  confirm: ConfirmDecision,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = text(row.id);
    return {
      id: id || `report-${index}`,
      cells: [
        id,
        display(row.targetType),
        display(row.targetId),
        display(row.category),
        display(row.status),
        display(row.priority),
        date(row.createdAt),
        canDecide ? (
          <div className="flex gap-1">
            <Action
              icon={<ClipboardCheck className="h-4 w-4" />}
              label="Action"
              onClick={() =>
                confirm({
                  kind: "action",
                  id,
                  endpoint: `/api/v2/admin/moderation/reports/${id}/decision`,
                  method: "POST",
                  title: `Action report ${id}`,
                  payload: () => ({
                    decision: "actioned",
                    policyCode: "manual_review",
                  }),
                })
              }
            />
            <Action
              icon={<Check className="h-4 w-4" />}
              label="Close"
              onClick={() =>
                confirm({
                  kind: "close",
                  id,
                  endpoint: `/api/v2/admin/moderation/reports/${id}/decision`,
                  method: "POST",
                  title: `Close report ${id}`,
                  payload: () => ({ decision: "no_violation" }),
                })
              }
            />
          </div>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}
function appealRows(
  rows: Row[],
  canDecide: boolean,
  confirm: ConfirmDecision,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = text(row.id);
    const action = (
      kind: "uphold" | "overturn" | "modify",
      outcome: string,
      icon: ReactNode,
      label: string,
    ) => (
      <Action
        icon={icon}
        label={label}
        onClick={() =>
          confirm({
            kind,
            id,
            endpoint: `/api/v2/admin/moderation/appeals/${id}/decision`,
            method: "POST",
            title: `${label} appeal ${id}`,
            payload: (reason) => ({ outcome, notes: reason }),
          })
        }
      />
    );
    return {
      id: id || `appeal-${index}`,
      cells: [
        id,
        display(row.userId),
        display(row.targetType),
        display(row.targetId),
        display(row.status),
        date(row.createdAt),
        canDecide ? (
          <div className="flex gap-1">
            {action(
              "uphold",
              "upheld",
              <Check className="h-4 w-4" />,
              "Uphold",
            )}
            {action(
              "overturn",
              "overturned",
              <RotateCcw className="h-4 w-4" />,
              "Overturn",
            )}
            {action(
              "modify",
              "modified",
              <ClipboardCheck className="h-4 w-4" />,
              "Modify",
            )}
          </div>
        ) : (
          "Read only"
        ),
      ],
    };
  });
}
function AuthoritySection({
  caption,
  empty,
  loadingLabel,
  rows,
  state,
}: {
  caption: string;
  empty: string;
  loadingLabel: string;
  rows: DataTableRow[];
  state: AuthorityState;
}) {
  if (!state.rows && state.loading)
    return (
      <div
        aria-label={loadingLabel}
        className="rounded-lg border p-4"
        role="status"
      >
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
        {loadingLabel}
      </div>
    );
  if (!state.rows) return null;
  return rows.length ? (
    <DataTable
      caption={caption}
      headers={
        caption === "Reports"
          ? [
              "ID",
              "Target type",
              "Target",
              "Category",
              "Status",
              "Priority",
              "Created",
              "Actions",
            ]
          : caption === "Appeals"
            ? [
                "ID",
                "User",
                "Target type",
                "Target",
                "Status",
                "Created",
                "Actions",
              ]
            : [
                "Preview",
                "ID",
                "Character",
                "Owner",
                "Safety",
                "Lineage",
                "Created",
                "Actions",
              ]
      }
      rows={rows}
    />
  ) : (
    <EmptyState
      hint="The complete moderation authority query returned no work."
      title={empty}
    />
  );
}
function Freshness({ label, state }: { label: string; state: AuthorityState }) {
  const { t } = useAdminI18n();
  const time = state.refreshedAt
    ? new Date(state.refreshedAt).toLocaleTimeString()
    : "unknown";
  if (state.loading && state.rows)
    return (
      <span>
        {label}{t(": refreshing · showing snapshot from")} {time}
      </span>
    );
  if (state.error && state.rows)
    return (
      <span>
        {label}{t(": stale · last good")} {time}
      </span>
    );
  if (state.error) return <span>{label}{t(": unavailable")}</span>;
  if (state.rows)
    return (
      <span>
        {label}{t(": current client snapshot ·")} {time}
      </span>
    );
  return <span>{label}{t(": refreshing · no snapshot yet")}</span>;
}
function AuthorityError({
  label,
  onRetry,
  state,
}: {
  label: string;
  onRetry: () => void;
  state: AuthorityState;
}) {
  const { t } = useAdminI18n();
  return state.error ? (
    <div
      className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
      role="alert"
    >
      {label}  {t("authority refresh failed:")} {state.error}
      <button
        className="ml-3 min-h-8 rounded border border-current px-2"
        onClick={onRetry}
        type="button"
      >

        {t("Retry")} {label}
      </button>
      {state.rows ? (
        <span className="ml-2">{t("The last good snapshot remains visible.")}</span>
      ) : null}
    </div>
  ) : null;
}
function Pager({
  cursor,
  label,
  loading,
  navigate,
  pageInfo,
  query,
}: {
  cursor: "reportCursor" | "mediaCursor" | "appealCursor";
  label: string;
  loading: boolean;
  navigate: (query: ModerationQuery) => void;
  pageInfo: PageInfo;
  query: ModerationQuery;
}) {
  return pageInfo.hasNextPage && pageInfo.endCursor ? (
    <button
      className="inline-flex min-h-11 items-center gap-2 rounded border px-4 text-sm font-semibold"
      disabled={loading}
      onClick={() => navigate({ ...query, [cursor]: pageInfo.endCursor ?? "" })}
      type="button"
    >
      <RefreshCcw className="h-4 w-4" />
      {label}
    </button>
  ) : null;
}
function Action({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
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
  search = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  search?: boolean;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
      <input
        className="min-h-11 rounded-md border bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        role={search ? "searchbox" : undefined}
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
          <option key={option || "all"} value={option}>
            {option || "All"}
          </option>
        ))}
      </select>
    </label>
  );
}
function currentQuery() {
  return typeof window === "undefined"
    ? defaultModerationQuery
    : moderationQueryFromSearch(window.location.search);
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
