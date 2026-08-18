"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import Image from "next/image";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCheck,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
import { apiGet, apiWrite } from "@/components/admin/api";
import { GhostButton } from "@/components/admin/ui/buttons";
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
import { useToast } from "@/components/admin/ui/Toast";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  defaultModerationQuery,
  MODERATION_PAGE_SIZE,
  moderationDecisionConfirmation,
  moderationQueryFromSearch,
  moderationQueuePath,
  moderationWorkspaceUrl,
  type ModerationQuery,
  type ModerationScope,
} from "./query";

type Row = Record<string, unknown>;
type AdminFormat = ReturnType<typeof useAdminFormat>;
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
  cause: unknown;
  loading: boolean;
  refreshedAt: string | null;
};
type ModerationDecisionKind =
  | "action"
  | "close"
  | "uphold"
  | "overturn"
  | "modify"
  | "media_pass"
  | "media_block";
type CursorKey = "reportCursor" | "mediaCursor" | "appealCursor";
const emptyTrails = (): Record<ModerationScope, string[]> => ({ reports: [], media: [], appeals: [] });
const emptyState = (): AuthorityState => ({
  rows: null,
  pageInfo: emptyPageInfo,
  error: null,
  cause: undefined,
  loading: true,
  refreshedAt: null,
});

export function ModerationWorkspace({ canDecide }: { canDecide: boolean }) {
  const { t, value } = useAdminI18n();
  const format = useAdminFormat();
  const { toast } = useToast();
  const [query, setQuery] = useState<ModerationQuery>(() => currentQuery());
  const [draft, setDraft] = useState<ModerationQuery>(() => currentQuery());
  const [reports, setReports] = useState<AuthorityState>(emptyState);
  const [media, setMedia] = useState<AuthorityState>(emptyState);
  const [appeals, setAppeals] = useState<AuthorityState>(emptyState);
  // SPEC: 三块队列各有自己的翻页栈 —— 「上一页」走自己走过的游标回头，不给后端发 `before`。
  // INTENT: 审核队列还是单向 keyset（响应里没有 startCursor / hasPreviousPage），
  //         第一页时 hasPrevious 为假 —— 置灰而不是给一个会 400 的按钮。
  const [trails, setTrails] = useState<Record<ModerationScope, string[]>>(emptyTrails);
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
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
          cause: undefined,
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
            cause,
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
      setTrails(emptyTrails);
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

  function navigate(
    next: ModerationQuery,
    mode: "push" | "replace" = "push",
    nextTrails: Record<ModerationScope, string[]> = emptyTrails(),
  ) {
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
    setTrails(nextTrails);
    load(next);
  }

  // SPEC: 翻某一块队列时另外两块原地不动 —— 三块共用一个 URL，但各自独立分页。
  function goToPage(scope: ModerationScope, cursorKey: CursorKey, cursor: string) {
    navigate({ ...query, [cursorKey]: cursor }, "push", {
      ...trails,
      [scope]: [...trails[scope], query[cursorKey]],
    });
  }

  function goBack(scope: ModerationScope, cursorKey: CursorKey) {
    const trail = trails[scope];
    navigate({ ...query, [cursorKey]: trail.at(-1) ?? "" }, "push", {
      ...trails,
      [scope]: trail.slice(0, -1),
    });
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, reportCursor: "", mediaCursor: "", appealCursor: "" });
  }

  function confirmDecision(input: {
    kind: ModerationDecisionKind;
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
      consequence: moderationConsequence(input.kind, t),
      reasonLabel: "Reason",
      submitLabel: "Confirm",
      onSubmit: async (reason) => {
        await apiWrite(
          input.endpoint,
          input.method,
          { ...input.payload(reason), reason, confirmation: expected },
          { "idempotency-key": idempotencyKey },
        );
        toast({ tone: "success", title: t("Decision recorded for {id}", { id: input.id }) });
        navigate(
          { ...query, reportCursor: "", mediaCursor: "", appealCursor: "" },
          "replace",
        );
      },
    });
  }

  const filtered = Boolean(query.search || query.status || query.targetType);
  // INTENT: 筛空了给一条出路。三块队列共用一个筛选器，所以清除也只有一个动作。
  const clearFilters = filtered ? (
    <GhostButton onClick={() => navigate(defaultModerationQuery)}>
      {t("Clear filters")}
    </GhostButton>
  ) : null;
  return (
    <section className="space-y-5">
      <PageHeader
        purpose={t("Review reports, independently pending Character images, blocked media, and appeals from separate authority snapshots; every decision is confirmed, audited, and propagated.")}
        title={t("Moderation Cases")}
      />
      <div
        className="flex flex-wrap justify-between gap-2 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <div className="flex flex-wrap gap-3">
          <Freshness label="Reports" state={reports} />
          <Freshness label="Media review" state={media} />
          <Freshness label="Appeals" state={appeals} />
        </div>
        {!canDecide ? <PermissionNotice permission="safety.review.write" /> : null}
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
      <AuthorityError
        onRetry={() => void loadScope(query, "reports")}
        state={reports}
      />
      <AuthorityError
        onRetry={() => void loadScope(query, "media")}
        state={media}
      />
      <AuthorityError
        onRetry={() => void loadScope(query, "appeals")}
        state={appeals}
      />
      <AuthoritySection
        action={clearFilters}
        caption="Reports"
        empty={
          filtered
            ? "No reports match these filters"
            : "No reports require review"
        }
        hint={
          filtered
            ? t("These filters match nothing right now. Clearing them shows the whole queue.")
            : t("The complete moderation authority query returned no work.")
        }
        loadingLabel="Loading reports…"
        state={reports}
        rows={reportRows(reports.rows ?? [], canDecide, confirmDecision, t, value, format)}
      />
      <QueuePagination
        onNext={(cursor) => goToPage("reports", "reportCursor", cursor)}
        onPrevious={() => goBack("reports", "reportCursor")}
        state={reports}
        trail={trails.reports}
      />
      <AuthoritySection
        action={clearFilters}
        caption="Media Review"
        empty={
          query.search
            ? "No media review items match this search"
            : "No Character images await independent review"
        }
        hint={
          query.search
            ? t("These filters match nothing right now. Clearing them shows the whole queue.")
            : t("The complete moderation authority query returned no work.")
        }
        loadingLabel="Loading media review…"
        state={media}
        rows={mediaRows(media.rows ?? [], canDecide, confirmDecision, t, value, format)}
      />
      <QueuePagination
        onNext={(cursor) => goToPage("media", "mediaCursor", cursor)}
        onPrevious={() => goBack("media", "mediaCursor")}
        state={media}
        trail={trails.media}
      />
      <AuthoritySection
        action={clearFilters}
        caption="Appeals"
        empty={
          query.search
            ? "No appeals match this search"
            : "No appeals require review"
        }
        hint={
          query.search
            ? t("These filters match nothing right now. Clearing them shows the whole queue.")
            : t("The complete moderation authority query returned no work.")
        }
        loadingLabel="Loading appeals…"
        state={appeals}
        rows={appealRows(appeals.rows ?? [], canDecide, confirmDecision, t, value, format)}
      />
      <QueuePagination
        onNext={(cursor) => goToPage("appeals", "appealCursor", cursor)}
        onPrevious={() => goBack("appeals", "appealCursor")}
        state={appeals}
        trail={trails.appeals}
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
  value: (key: string) => string,
  format: AdminFormat,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = format.text(row.id);
    const characterId = format.text(row.characterId);
    const safetyStatus = format.text(row.safetyStatus);
    const pending = safetyStatus === "unknown" || safetyStatus === "flagged";
    const preview = format.text(row.thumbnailUrl) || format.text(row.url);
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
          t("No preview")
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
        format.display(row.ownerId),
        safetyStatus ? value(safetyStatus) : "—",
        format.text(row.sourceAssetId)
          ? t("Duplicate of {id}", { id: format.text(row.sourceAssetId) })
          : value(format.text(row.reviewKind)) || "—",
        format.dateTime(row.createdAt),
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
          t("Terminal")
        ) : (
          t("Read only")
        ),
      ],
    };
  });
}

function reportRows(
  rows: Row[],
  canDecide: boolean,
  confirm: ConfirmDecision,
  t: (key: string, values?: Record<string, string | number>) => string,
  value: (key: string) => string,
  format: AdminFormat,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = format.text(row.id);
    return {
      id: id || `report-${index}`,
      cells: [
        id,
        <TargetCell
          id={format.text(row.targetId)}
          key="target"
          type={format.text(row.targetType)}
        />,
        value(format.text(row.category)) || "—",
        // SPEC: 举报人写的原文就是这条举报的证据本体。
        // INTENT: 权威接口一直返回 description 与 reporterId，工作台以前两个都没画——
        //         审核员只能看着 category 这个下拉框选项在「处置」和「无违规」之间二选一。
        <CaseText
          key="evidence"
          label={t("Reporter statement")}
          value={format.text(row.description)}
        />,
        format.display(row.reporterId),
        value(format.text(row.status)) || "—",
        format.display(row.priority),
        format.dateTime(row.createdAt),
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
                  title: t("Action report {id}", { id }),
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
                  title: t("Close report {id}", { id }),
                  payload: () => ({ decision: "no_violation" }),
                })
              }
            />
          </div>
        ) : (
          t("Read only")
        ),
      ],
    };
  });
}
function appealRows(
  rows: Row[],
  canDecide: boolean,
  confirm: ConfirmDecision,
  t: (key: string, values?: Record<string, string | number>) => string,
  value: (key: string) => string,
  format: AdminFormat,
): DataTableRow[] {
  return rows.map((row, index) => {
    const id = format.text(row.id);
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
            title: t("{action} appeal {id}", { action: t(label), id }),
            payload: (reason) => ({ outcome, notes: reason }),
          })
        }
      />
    );
    return {
      id: id || `appeal-${index}`,
      cells: [
        id,
        format.display(row.userId),
        <TargetCell
          id={format.text(row.targetId)}
          key="target"
          type={format.text(row.targetType)}
        />,
        // SPEC: 申诉正文——用户为什么认为那次处置错了。
        // INTENT: 「维持」和「撤销」是把一次处置钉死或整个掀翻，而以前这一列根本不存在：
        //         审核员在没读过申诉理由的情况下就得二选一。appealText 一直在响应里。
        <CaseText
          key="appeal"
          label={t("Appeal statement")}
          value={format.text(row.appealText)}
        />,
        format.display(row.originalDecisionId),
        value(format.text(row.status)) || "—",
        format.dateTime(row.createdAt),
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
          t("Read only")
        ),
      ],
    };
  });
}
function AuthoritySection({
  action,
  caption,
  empty,
  hint,
  loadingLabel,
  rows,
  state,
}: {
  action?: ReactNode;
  caption: string;
  empty: string;
  hint: string;
  loadingLabel: string;
  rows: DataTableRow[];
  state: AuthorityState;
}) {
  const { t } = useAdminI18n();
  if (!state.rows && state.loading)
    return (
      <div
        aria-label={t(loadingLabel)}
        className="rounded-lg border p-4"
        role="status"
      >
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
        {t(loadingLabel)}
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
              "Target",
              "Category",
              "Reported content",
              "Reporter",
              "Status",
              "Priority",
              "Created",
              "Actions",
            ]
          : caption === "Appeals"
            ? [
                "ID",
                "User",
                "Target",
                "Appeal",
                "Original decision",
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
      minimumWidthClassName="min-w-[1400px]"
      rows={rows}
      stickyLastColumn
    />
  ) : (
    <EmptyState action={action} hint={hint} title={empty} />
  );
}

// SPEC: 举报 / 申诉的正文。短的直接摊开，长的折起来但保留开头。
// INTENT: 审核员扫队列时需要「一眼看出这条大概在说什么」，做决定时需要「一个字不差的原文」。
//         全文平铺会把行高撑到一屏一条，全折叠又让扫队列变成逐条点开——所以按长度分。
function CaseText({ label, value }: { label: string; value: string }) {
  const { t } = useAdminI18n();
  if (!value.trim())
    return (
      <span className="text-[var(--ad-text-muted)]">{t("Nothing written")}</span>
    );
  if (value.length <= 90)
    return <span className="block max-w-xs break-words">{value}</span>;
  return (
    <details className="max-w-xs">
      <summary
        aria-label={label}
        className="cursor-pointer rounded break-words focus-visible:outline focus-visible:outline-2"
      >
        {`${value.slice(0, 90)}…`}
      </summary>
      <p className="mt-2 break-words whitespace-pre-wrap text-xs">{value}</p>
    </details>
  );
}

// INTENT: 举报的目标以前是一串裸 ID，审核员要看被举报的东西得自己复制去搜。角色有详情页就
//         直接给链接；其它 target 类型后台还没有落地页，所以只把类型标出来，不编一个会 404 的链接。
function TargetCell({ id, type }: { id: string; type: string }) {
  const { value } = useAdminI18n();
  if (!id) return <>—</>;
  return (
    <span className="block">
      <span className="block text-xs uppercase tracking-[0.05em] text-[var(--ad-text-muted)]">
        {type ? value(type) : "—"}
      </span>
      {type === "character" ? (
        <a className="underline underline-offset-4" href={`/admin/characters/${id}`}>
          {id}
        </a>
      ) : (
        <span className="block break-words">{id}</span>
      )}
    </span>
  );
}
// INVARIANT: label 是队列名，必须过 t()。它以前裸渲染，于是中文界面上三条新鲜度提示的开头
// 永远是 "Reports" / "Media review" / "Appeals"，后半截却是中文。
function Freshness({ label, state }: { label: string; state: AuthorityState }) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const time = state.refreshedAt ? format.time(state.refreshedAt) : t("unknown");
  if (state.loading && state.rows)
    return (
      <span>
        {t(label)}{t(": refreshing · as of")} {time}
      </span>
    );
  if (state.error && state.rows)
    return (
      <span>
        {t(label)}{t(": stale · last good")} {time}
      </span>
    );
  if (state.error) return <span>{t(label)}{t(": unavailable")}</span>;
  if (state.rows)
    return (
      <span>
        {t(label)}{t(": as of")} {time}
      </span>
    );
  return <span>{t(label)}{t(": loading…")}</span>;
}
function AuthorityError({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: AuthorityState;
}) {
  if (!state.error) return null;
  return (
    <AuthorityRequestError
      cause={state.cause}
      message={state.error}
      onRetry={onRetry}
      snapshotAt={state.rows ? state.refreshedAt : null}
    />
  );
}
function QueuePagination({
  onNext,
  onPrevious,
  state,
  trail,
}: {
  onNext: (cursor: string) => void;
  onPrevious: () => void;
  state: AuthorityState;
  trail: string[];
}) {
  if (!state.rows?.length) return null;
  const { endCursor, hasNextPage } = state.pageInfo;
  return (
    <Pagination
      hasNext={Boolean(hasNextPage && endCursor)}
      hasPrevious={trail.length > 0}
      loading={state.loading}
      onNext={() => endCursor && onNext(endCursor)}
      onPrevious={onPrevious}
      page={trail.length + 1}
      pageSize={MODERATION_PAGE_SIZE}
      rowCount={state.rows.length}
    />
  );
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
  const { t } = useAdminI18n();
  return (
    <button
      aria-label={t(label)}
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
  search = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  search?: boolean;
  value: string;
}) {
  const { t } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
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
          <option key={option || "all"} value={option}>
            {option ? enumLabel(option) : enumLabel("all")}
          </option>
        ))}
      </select>
    </label>
  );
}
// SPEC: 每一种审核裁决落地后会发生什么、能不能改。
// INTENT: 「Block」和「Overturn」在按钮上只差两个词，但一个是把内容从用户面前撤走、
//         一个是把已经撤走的放回去；运营敲确认串之前必须先读到这个区别。
// INVARIANT: 七种 kind 全部有条目——漏一种就会退回没有后果说明的旧行为，由 mounted 测试守住。
function moderationConsequence(
  kind: ModerationDecisionKind,
  t: (key: string) => string,
): { effect: string; reversible: boolean } {
  switch (kind) {
    case "media_block":
      return {
        effect: t("The image disappears from every public surface at once. Passing it later puts it back."),
        reversible: true,
      };
    case "media_pass":
      return {
        effect: t("The image becomes publicly visible at once. Blocking it later takes it down again."),
        reversible: true,
      };
    case "action":
      return {
        effect: t("The enforcement lands on the reported target and the report moves to actioned."),
        reversible: false,
      };
    case "close":
      return {
        effect: t("The report closes with no enforcement and leaves the queue. Reopening means filing a new report."),
        reversible: false,
      };
    case "uphold":
      return {
        effect: t("The original decision stands and the appeal closes. The user cannot appeal the same decision again."),
        reversible: false,
      };
    case "overturn":
      return {
        effect: t("The original enforcement is lifted and the appeal closes in the user's favour."),
        reversible: false,
      };
    case "modify":
      return {
        effect: t("The original enforcement is replaced with the revised one and the appeal closes."),
        reversible: false,
      };
  }
}

function currentQuery() {
  return typeof window === "undefined"
    ? defaultModerationQuery
    : moderationQueryFromSearch(window.location.search);
}
