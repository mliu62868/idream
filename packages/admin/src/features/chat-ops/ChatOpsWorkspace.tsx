"use client";

import {
  MAIN_TO_CHAT_REPLAY_CONFIRMATION,
  MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
  type MainToChatOutboxEvent,
  type MainToChatOutboxEventListResponse,
} from "@idream/shared/admin";
import { adminDateLocale, useAdminI18n } from "@/components/admin/i18n";
import { Loader2, RefreshCcw, RotateCcw, Search } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/components/admin/api";
import {
  ConfirmDialog,
  type ConfirmSpec,
} from "@/components/admin/ui/ConfirmDialog";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
import { adminV2Operation } from "@/lib/admin-v2-operation";
import { canonicalListEmptyTitle } from "@/features/compatibility-lists/empty-state";
import {
  chatOpsPath,
  chatOpsQueryFromSearch,
  chatOpsWorkspaceUrl,
  defaultChatOpsQuery,
  type ChatOpsAuthority,
  type ChatOpsQuery,
} from "./query";

type Row = Record<string, unknown>;
type PageInfo = { endCursor: string | null; hasNextPage: boolean };
type Diagnostics = {
  reason?:
    | "missing_url"
    | "unreachable"
    | "unauthorized"
    | "upstream_error"
    | "bad_json";
  status?: number;
  serviceUrlConfigured: boolean;
};
type ChatResponse = {
  configured: boolean;
  diagnostics?: Diagnostics;
  overview?: Row | null;
  items?: Row[];
  pageInfo?: PageInfo;
};
type AuthorityState = {
  data: ChatResponse | null;
  loading: boolean;
  error: string | null;
  refreshedAt: string | null;
};

export function mainToChatReplayPayload(
  events: readonly MainToChatOutboxEvent[],
  reason: string,
) {
  return {
    events: events.map((event) => ({
      id: event.id,
      expectedAttempts: event.attempts,
      expectedUpdatedAt: event.updatedAt,
    })),
    reason: {
      code: "operator_replay",
      summary: reason.trim(),
    },
    confirmation: MAIN_TO_CHAT_REPLAY_CONFIRMATION,
  };
}

export function summarizeMainToChatReplay(
  results: ReadonlyArray<{ readonly outcome: string }>,
) {
  const counts = new Map<string, number>();
  for (const { outcome } of results) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `${outcome}: ${count}`)
    .join(" · ");
}

export function mainToChatTargetMissingPayload(
  events: readonly MainToChatOutboxEvent[],
  reason: string,
) {
  return {
    events: events.map((event) => ({
      id: event.id,
      expectedAttempts: event.attempts,
      expectedUpdatedAt: event.updatedAt,
      expectedEnvelopeHash: event.envelopeHash!,
      expectedTarget: event.receiverAuthority.target!,
    })),
    reason: {
      code: "receiver_target_missing",
      summary: reason.trim(),
    },
    confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
  };
}

function replayAllowed(event: MainToChatOutboxEvent) {
  return event.envelopeHash !== null && [
    "exact_receipt",
    "target_present",
    "no_target_required",
  ].includes(event.receiverAuthority.disposition);
}

function targetMissingDiscardAllowed(event: MainToChatOutboxEvent) {
  return event.envelopeHash !== null &&
    [
      "expected_target_missing",
      // Chat may have committed its idempotent receipt before Main rolled back.
      // Re-running this command finalizes Main; replay must remain disabled.
      "discarded_target_missing",
    ].includes(event.receiverAuthority.disposition) &&
    event.receiverAuthority.target !== null;
}

function rowActionable(
  event: MainToChatOutboxEvent,
  canReplay: boolean,
  canDiscardMissing: boolean,
) {
  return (canReplay && replayAllowed(event)) ||
    (canDiscardMissing && targetMissingDiscardAllowed(event));
}

function receiverAuthorityLabel(
  disposition: MainToChatOutboxEvent["receiverAuthority"]["disposition"],
) {
  switch (disposition) {
    case "expected_target_missing":
      return "Expected target missing";
    case "target_present":
      return "Target present · replay eligible";
    case "exact_receipt":
      return "Exact receiver receipt · replay eligible";
    case "no_target_required":
      return "No receiver target required · replay eligible";
    case "discarded_target_missing":
      return "Target missing already recorded";
    case "receiver_hash_conflict":
      return "Receiver envelope hash conflict";
    case "receiver_quarantined":
      return "Receiver receipt quarantined";
    case "invalid_event_payload":
      return "Invalid event payload";
    case "invalid_envelope":
      return "Invalid durable envelope";
    case "unavailable":
      return "Receiver authority unavailable";
  }
}

const authorities: ChatOpsAuthority[] = [
  "overview",
  "providers",
  "sessions",
  "usage",
  "events",
];
const emptyPageInfo: PageInfo = { endCursor: null, hasNextPage: false };

function initialStates(): Record<ChatOpsAuthority, AuthorityState> {
  return Object.fromEntries(
    authorities.map((authority) => [
      authority,
      {
        data: null,
        loading: true,
        error: null,
        refreshedAt: null,
      },
    ]),
  ) as Record<ChatOpsAuthority, AuthorityState>;
}

export function ChatOpsWorkspace({
  canRead,
  canReadMainOutbox = false,
  canReplayMainOutbox = false,
  canDiscardMissingMainOutbox = false,
}: {
  canRead: boolean;
  canReadMainOutbox?: boolean;
  canReplayMainOutbox?: boolean;
  canDiscardMissingMainOutbox?: boolean;
}) {
  const { t } = useAdminI18n();
  const [query, setQuery] = useState<ChatOpsQuery>(() => currentQuery());
  const [draft, setDraft] = useState<ChatOpsQuery>(() => currentQuery());
  const [states, setStates] =
    useState<Record<ChatOpsAuthority, AuthorityState>>(initialStates);
  const gates = useRef(
    Object.fromEntries(
      authorities.map((authority) => [authority, createLatestRequestGate()]),
    ) as Record<ChatOpsAuthority, ReturnType<typeof createLatestRequestGate>>,
  );
  const initialQuery = useRef(query);

  const loadAuthority = useCallback(
    async (next: ChatOpsQuery, authority: ChatOpsAuthority) => {
      const request = gates.current[authority].begin();
      setStates((current) => ({
        ...current,
        [authority]: { ...current[authority], loading: true, error: null },
      }));
      try {
        const response = await apiGet<ChatResponse>(
          chatOpsPath(next, authority),
        );
        if (!request.isCurrent()) return;
        setStates((current) => ({
          ...current,
          [authority]: {
            data: response,
            loading: false,
            error: null,
            refreshedAt: new Date().toISOString(),
          },
        }));
      } catch (cause) {
        if (!request.isCurrent()) return;
        setStates((current) => ({
          ...current,
          [authority]: {
            ...current[authority],
            loading: false,
            error:
              cause instanceof Error
                ? cause.message
                : `${authority} authority request failed`,
          },
        }));
      }
    },
    [],
  );

  const load = useCallback(
    (next: ChatOpsQuery) => {
      if (!canRead) return;
      for (const authority of authorities) void loadAuthority(next, authority);
    },
    [canRead, loadAuthority],
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
      for (const authority of authorities) requestGates[authority].invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
  }, [load]);

  function navigate(next: ChatOpsQuery, mode: "push" | "replace" = "push") {
    const url = chatOpsWorkspaceUrl(
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
    load(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ ...draft, sessionCursor: "", usageCursor: "", eventCursor: "" });
  }

  // SPEC: 五个 authority 各自独立报 configured；顶栏必须说清"几个还活着"。
  // INTENT: 旧口径是 .some(configured)——五个里活一个也照样显示"Chat Service connected"，
  //         值班的人看一眼以为没事，实际四个authority已经拿不到数据了。
  const answered = authorities.filter((authority) => states[authority].data !== null);
  const degraded = answered.filter((authority) => !states[authority].data?.configured);
  const overview = states.overview.data?.overview ?? null;
  return (
    <section className="space-y-5">
      <PageHeader
        purpose={t("Inspect Chat Service health, session metadata, quota usage, and moderation events without exposing message plaintext.")}
        title={t("Chat Operations")}
      />
      <div
        className="flex flex-wrap justify-between gap-3 text-xs text-[var(--ad-text-muted)]"
        role="status"
      >
        <div className="flex flex-wrap gap-3">
          <Freshness authority="Overview" state={states.overview} />
          <Freshness authority="Provider health" state={states.providers} />
          <Freshness authority="Sessions" state={states.sessions} />
          <Freshness authority="Usage" state={states.usage} />
          <Freshness authority="Events" state={states.events} />
        </div>
        {!canRead ? (
          <strong>{t("No access · chat.ops.read is not granted")}</strong>
        ) : answered.length === 0 ? (
          <strong>{t("Chat Service state not established yet")}</strong>
        ) : degraded.length === 0 ? (
          <strong>{t("Chat Service connected")}</strong>
        ) : (
          <strong className="text-[var(--ad-yellow-text)]">
            {t("Chat Service degraded · {degraded} of {total} authorities unavailable", {
              degraded: degraded.length,
              total: authorities.length,
            })}
          </strong>
        )}
      </div>
      <form
        className="grid gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 md:grid-cols-2 xl:grid-cols-4"
        onSubmit={apply}
      >
        <Field
          label="User ID"
          onChange={(userId) => setDraft((value) => ({ ...value, userId }))}
          value={draft.userId}
        />
        <Field
          label="Character ID"
          onChange={(characterId) =>
            setDraft((value) => ({ ...value, characterId }))
          }
          value={draft.characterId}
        />
        <Select
          label="Session status"
          onChange={(sessionStatus) =>
            setDraft((value) => ({ ...value, sessionStatus }))
          }
          options={["active", "archived", "deleted", "all"]}
          value={draft.sessionStatus}
        />
        <Select
          label="Rows"
          onChange={(limit) => setDraft((value) => ({ ...value, limit }))}
          numeric
          options={["25", "50", "100"]}
          value={draft.limit}
        />
        <Select
          label="Event status"
          onChange={(eventStatus) =>
            setDraft((value) => ({ ...value, eventStatus }))
          }
          options={["all", "blocked", "flagged", "passed"]}
          value={draft.eventStatus}
        />
        <Select
          label="Event layer"
          onChange={(eventLayer) =>
            setDraft((value) => ({ ...value, eventLayer }))
          }
          options={["all", "input", "output"]}
          value={draft.eventLayer}
        />
        <Field
          label="Policy code"
          onChange={(policyCode) =>
            setDraft((value) => ({ ...value, policyCode }))
          }
          value={draft.policyCode}
        />
        <Field
          label="Target ID"
          onChange={(targetId) => setDraft((value) => ({ ...value, targetId }))}
          value={draft.targetId}
        />
        <div className="flex gap-2 md:col-span-2 xl:col-span-4">
          <button
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
            disabled={!canRead}
            type="submit"
          >
            <Search className="h-4 w-4" />

            {t("Filter Chat Ops")}
          </button>
          <button
            className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4 text-sm"
            onClick={() => navigate(defaultChatOpsQuery)}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />

            {t("Reset")}
          </button>
        </div>
      </form>
      <MainToChatFailedOutboxPanel
        canRead={canReadMainOutbox}
        canReplay={canReplayMainOutbox}
        canDiscardMissing={canDiscardMissingMainOutbox}
      />
      {canRead ? (
        <>
          <AuthorityError
            authority="overview"
            query={query}
            retry={loadAuthority}
            state={states.overview}
          />
          <DiagnosticsNotice data={states.overview.data} />
          {states.overview.data ? (
            <ChatOpsOverviewCards overview={overview} />
          ) : (
            <Loading authority={AUTHORITY_LABELS.overview} state={states.overview} />
          )}

          <AuthorityError
            authority="providers"
            query={query}
            retry={loadAuthority}
            state={states.providers}
          />
          <DiagnosticsNotice data={states.providers.data} />
          <AuthorityTable
            authority="providers"
            empty="No chat providers are configured"
            rows={states.providers.data?.items ?? []}
            state={states.providers}
          />

          <AuthorityError
            authority="usage"
            query={query}
            retry={loadAuthority}
            state={states.usage}
          />
          <DiagnosticsNotice data={states.usage.data} />
          <AuthorityTable
            authority="usage"
            empty={
              query.userId
                ? "No chat usage matches this user"
                : "No chat usage exists for the current product day"
            }
            rows={states.usage.data?.items ?? []}
            state={states.usage}
          />
          <Pager
            authority="usage"
            label="Next usage page"
            navigate={navigate}
            pageInfo={states.usage.data?.pageInfo ?? emptyPageInfo}
            query={query}
          />

          <AuthorityError
            authority="sessions"
            query={query}
            retry={loadAuthority}
            state={states.sessions}
          />
          <DiagnosticsNotice data={states.sessions.data} />
          <AuthorityTable
            authority="sessions"
            empty={canonicalListEmptyTitle(
              "chat_sessions",
              sessionFiltered(query),
            )}
            rows={states.sessions.data?.items ?? []}
            state={states.sessions}
          />
          <Pager
            authority="sessions"
            label="Next session page"
            navigate={navigate}
            pageInfo={states.sessions.data?.pageInfo ?? emptyPageInfo}
            query={query}
          />

          <AuthorityError
            authority="events"
            query={query}
            retry={loadAuthority}
            state={states.events}
          />
          <DiagnosticsNotice data={states.events.data} />
          <AuthorityTable
            authority="events"
            empty={
              eventFiltered(query)
                ? "No chat events match these filters"
                : "No chat events exist yet"
            }
            rows={states.events.data?.items ?? []}
            state={states.events}
          />
          <Pager
            authority="events"
            label="Next event page"
            navigate={navigate}
            pageInfo={states.events.data?.pageInfo ?? emptyPageInfo}
            query={query}
          />
        </>
      ) : null}
    </section>
  );
}

function MainToChatFailedOutboxPanel({
  canRead,
  canReplay,
  canDiscardMissing,
}: {
  canRead: boolean;
  canReplay: boolean;
  canDiscardMissing: boolean;
}) {
  const { locale, t } = useAdminI18n();
  const [data, setData] =
    useState<MainToChatOutboxEventListResponse | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate());

  const load = useCallback(
    async (cursor = "") => {
      if (!canRead) return;
      const request = gate.current.begin();
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ status: "failed", limit: "50" });
      if (cursor) params.set("cursor", cursor);
      try {
        const response = await adminV2Operation(
          "GET /api/v2/admin/chat/main-outbox-events",
          { query: params },
        );
        if (!request.isCurrent()) return;
        setData(response);
        setSelected(new Set());
      } catch (cause) {
        if (!request.isCurrent()) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Main to Chat failed outbox request failed",
        );
      } finally {
        if (request.isCurrent()) setLoading(false);
      }
    },
    [canRead],
  );

  useEffect(() => {
    const requestGate = gate.current;
    const initialLoad = window.setTimeout(() => void load(), 0);
    const refresh = () => void load();
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    return () => {
      window.clearTimeout(initialLoad);
      requestGate.invalidate();
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, refresh);
    };
  }, [load]);

  const rows = data?.items ?? [];
  const selectableRows: MainToChatOutboxEvent[] = [];
  const selectedRows: MainToChatOutboxEvent[] = [];
  for (const row of rows) {
    if (!rowActionable(row, canReplay, canDiscardMissing)) continue;
    selectableRows.push(row);
    if (selected.has(row.id)) selectedRows.push(row);
  }
  const replayRows = selectedRows.filter(replayAllowed);
  const targetMissingRows = selectedRows.filter(targetMissingDiscardAllowed);
  const allSelected =
    selectableRows.length > 0 && selectedRows.length === selectableRows.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestReplay() {
    if (
      !canReplay ||
      selectedRows.length === 0 ||
      replayRows.length !== selectedRows.length
    ) return;
    const replayRevision = [...replayRows];
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: t("Replay Main → Chat failed events ({count})", {
        count: replayRevision.length,
      }),
      // SEAM: `consequence` 字段落地后把这段从 summary 平移过去。
      summary: (
        <span>
          {t(
            "The worker will retry the unchanged durable envelopes; no event is sent from this browser request. Retrying inside this dialog reuses the same idempotency key and cannot requeue twice.",
          )}
        </span>
      ),
      destructive: {
        expectedName: MAIN_TO_CHAT_REPLAY_CONFIRMATION,
        inputLabel: t("Replay confirmation"),
      },
      requireReason: true,
      reasonLabel: t("Replay reason (≥3)"),
      submitLabel: t("Queue replay"),
      onSubmit: async (reason) => {
        const result = await adminV2Operation(
          "POST /api/v2/admin/chat/main-outbox-events/commands/replay",
          {
            body: mainToChatReplayPayload(replayRevision, reason),
            idempotencyKey,
          },
        );
        setNotice(t("Main → Chat replay result · {summary}.", {
          summary: summarizeMainToChatReplay(result.results),
        }));
        await load();
      },
    });
  }

  function requestTargetMissingDisposition() {
    if (
      !canDiscardMissing ||
      selectedRows.length === 0 ||
      targetMissingRows.length !== selectedRows.length
    ) return;
    const missingRows = [...targetMissingRows];
    const idempotencyKey = crypto.randomUUID();
    setConfirmation({
      title: t("Record expected target missing ({count})", {
        count: missingRows.length,
      }),
      // SEAM: `consequence` 字段落地后把这段从 summary 平移过去。
      summary: (
        <span>
          {t(
            "This records that no user-visible Chat effect was applied and is terminal for Main. Main becomes terminal only after Chat stores the original envelope hash as a target-missing receipt. Retrying inside this dialog reuses the same idempotency key and cannot apply twice.",
          )}
        </span>
      ),
      destructive: {
        expectedName: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
        inputLabel: t("Target-missing confirmation"),
      },
      requireReason: true,
      reasonLabel: t("Target-missing reason (≥3)"),
      submitLabel: t("Record target missing"),
      onSubmit: async (reason) => {
        const result = await adminV2Operation(
          "POST /api/v2/admin/chat/main-outbox-events/commands/discard-target-missing",
          {
            body: mainToChatTargetMissingPayload(missingRows, reason),
            idempotencyKey,
          },
        );
        setNotice(t("Main → Chat target-missing result · {summary}.", {
          summary: summarizeMainToChatReplay(result.results),
        }));
        await load();
      },
    });
  }

  return (
    <section
      aria-labelledby="main-to-chat-failed-title"
      className="space-y-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold" id="main-to-chat-failed-title">
            {t("Main → Chat failed delivery")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-[var(--ad-text-muted)]">
            {t(
              "Inspect failed durable events and explicitly return selected envelopes to the worker queue.",
            )}
          </p>
        </div>
        <div className="text-right text-xs font-semibold text-[var(--ad-text-muted)]">
          {!canRead ? (
            <p>{t("Unavailable · ops.queue.read is not granted")}</p>
          ) : !canReplay ? (
            <p>
              {t("Replay unavailable · ops.deadletter.write is not granted")}
            </p>
          ) : null}
        </div>
      </div>
      {/* SEAM: 单一反馈出口 —— 全局 toast 落地后换成 `useToast()`；错误分支走 `useFailureToast()`
          + `ui/request-error-copy.ts`（5xx / 网络故障不能暗示"没有写入"）。 */}
      {notice ? (
        <p
          className="rounded-md bg-[var(--ad-green-bg)] p-3 text-sm text-[var(--ad-green-text)]"
          data-testid="main-to-chat-replay-status"
          role="status"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
          role="alert"
        >
          {t("Main → Chat failed delivery refresh failed:")} {error}
          <button
            className="ml-3 min-h-8 rounded border border-current px-2 font-semibold"
            onClick={() => void load()}
            type="button"
          >
            {t("Retry")}
          </button>
        </p>
      ) : null}
      {!canRead ? null : loading && !data ? (
        <Loading
          authority="Main → Chat failed delivery"
          state={{ data: null, loading: true, error: null, refreshedAt: null }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          hint={t(
            "Every Main → Chat durable event is pending, delivered, or explicitly terminalized.",
          )}
          title={t("No failed Main → Chat deliveries")}
        />
      ) : (
        <>
          {canReplay || canDiscardMissing ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-[var(--ad-text-muted)]">
                <input
                  aria-label={t("Select all failed Main to Chat events")}
                  checked={allSelected}
                  onChange={() =>
                    setSelected(
                      allSelected
                        ? new Set()
                        : new Set(selectableRows.map((row) => row.id)),
                    )
                  }
                  type="checkbox"
                />
                {t("Select all")}
              </label>
              <span className="text-xs text-[var(--ad-text-muted)]">
                {selectedRows.length} {t("selected")}
              </span>
              {canReplay ? (
                <button
                  className="ml-auto inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm font-semibold disabled:opacity-40"
                  disabled={
                    selectedRows.length === 0 ||
                    replayRows.length !== selectedRows.length
                  }
                  onClick={requestReplay}
                  type="button"
                >
                  <RefreshCcw className="h-4 w-4" />
                  {t("Replay selected")}
                </button>
              ) : null}
              {canDiscardMissing ? (
                <button
                  className={`${canReplay ? "" : "ml-auto "}inline-flex min-h-9 items-center gap-2 rounded-md border border-[var(--ad-border)] px-3 text-sm font-semibold disabled:opacity-40`}
                  disabled={
                    selectedRows.length === 0 ||
                    targetMissingRows.length !== selectedRows.length
                  }
                  onClick={requestTargetMissingDisposition}
                  type="button"
                >
                  <RotateCcw className="h-4 w-4" />
                  {t("Record target missing")}
                </button>
              ) : null}
            </div>
          ) : null}
          {/* SEAM: 手写表——`DataTable` 目前不支持多选。多选能力落地后整表迁过去。 */}
          <div
            aria-label={t("Failed Main to Chat delivery table")}
            className="overflow-x-auto rounded-lg border border-[var(--ad-border)]"
            role="region"
            tabIndex={0}
          >
            <table className="w-full min-w-[1080px] text-left text-sm">
              <caption className="sr-only">
                {t("Failed Main to Chat durable deliveries")}
              </caption>
              <thead>
                <tr className="border-b border-[var(--ad-border)] text-xs uppercase text-[var(--ad-text-muted)]">
                  {[
                    ...(canReplay || canDiscardMissing ? [""] : []),
                    "Event",
                    "Aggregate",
                    "Receiver authority",
                    "Attempts / retry",
                    "Last error",
                    "Envelope hash",
                    "Updated",
                  ].map((header, index) => (
                    <th
                      className="px-3 py-3 font-medium"
                      key={`${header}-${index}`}
                      scope="col"
                    >
                      {header ? t(header) : header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const disabledReasonId =
                    `main-to-chat-replay-disabled-${index}`;
                  return (
                    <tr
                      className="border-b border-[var(--ad-border)] last:border-0"
                      key={row.id}
                    >
                      {canReplay || canDiscardMissing ? (
                        <td className="px-3 py-3">
                          <input
                            aria-describedby={
                              !rowActionable(row, canReplay, canDiscardMissing)
                                ? disabledReasonId
                                : undefined
                            }
                            aria-label={t("Select failed event {id}", {
                              id: row.id,
                            })}
                            checked={selected.has(row.id)}
                            disabled={!rowActionable(
                              row,
                              canReplay,
                              canDiscardMissing,
                            )}
                            onChange={() => toggle(row.id)}
                            type="checkbox"
                          />
                        </td>
                      ) : null}
                      <td className="px-3 py-3">
                        <p className="font-medium">{row.eventType}</p>
                        <p className="font-mono text-xs text-[var(--ad-text-muted)]">
                          {row.id}
                        </p>
                      </td>
                      <td className="max-w-80 px-3 py-3 text-xs">
                        <p className="font-semibold">
                          {t(receiverAuthorityLabel(row.receiverAuthority.disposition))}
                        </p>
                        {row.receiverAuthority.target ? (
                          <p className="break-all font-mono text-[11px] text-[var(--ad-text-muted)]">
                            {row.receiverAuthority.target.kind}:{row.receiverAuthority.target.id}
                            {row.receiverAuthority.targetStatus
                              ? ` · ${row.receiverAuthority.targetStatus}`
                              : ""}
                          </p>
                        ) : null}
                        {row.envelopeHash !== null &&
                        !rowActionable(row, canReplay, canDiscardMissing) ? (
                          <span className="sr-only" id={disabledReasonId}>
                            {t("No safe action is available for this receiver authority state")}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <p>{row.aggregateType}</p>
                        <p className="font-mono text-xs text-[var(--ad-text-muted)]">
                          {row.aggregateId}
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <p>{row.attempts}</p>
                        <p className="text-xs text-[var(--ad-text-muted)]">
                          {date(row.nextRunAt, locale)}
                        </p>
                      </td>
                      <td className="max-w-80 px-3 py-3 text-xs">
                        {row.lastErrorMessage ?? "—"}
                      </td>
                      <td className="max-w-72 break-all px-3 py-3 font-mono text-[11px]">
                        {row.envelopeHash ?? (
                          <span id={disabledReasonId}>
                            {t("Replay unavailable · invalid durable envelope")}
                            {` · ${row.storedEnvelopeHash}`}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs">{date(row.updatedAt, locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data?.pageInfo.hasNextPage && data.pageInfo.endCursor ? (
            <button
              className="inline-flex min-h-11 items-center gap-2 rounded border border-[var(--ad-border)] px-4 text-sm font-semibold"
              disabled={loading}
              onClick={() => void load(data.pageInfo.endCursor ?? "")}
              type="button"
            >
              <RefreshCcw className="h-4 w-4" />
              {t("Next failed delivery page")}
            </button>
          ) : null}
        </>
      )}
      {confirmation ? (
        <ConfirmDialog
          onClose={() => setConfirmation(null)}
          spec={confirmation}
        />
      ) : null}
    </section>
  );
}

export function ChatOpsOverviewCards({ overview }: { overview: Row | null }) {
  const { t } = useAdminI18n();
  const cards = [
    ["Active sessions", overview?.activeSessions],
    ["Archived", overview?.archivedSessions],
    ["Messages 24h", overview?.messages24h],
    ["Moderation 24h", overview?.moderationEvents24h],
    ["Messages used today", overview?.messagesUsedToday],
    ["Users at daily limit", overview?.usersAtDailyLimit],
    ["Unlimited users", overview?.unlimitedEntitlements],
    ["Blocked moderation 24h", overview?.blockedModeration24h],
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border bg-black/[0.05] md:grid-cols-4">
      {cards.map(([label, value]) => (
        <div className="bg-[var(--ad-surface)] p-4" key={String(label)}>
          <p className="text-xs text-[var(--ad-text-muted)]">{t(String(label))}</p>
          <p className="mt-2 text-2xl font-semibold">
            {typeof value === "number" ? value : "—"}
          </p>
        </div>
      ))}
    </div>
  );
}

// SPEC: [响应字段, 表头文案]。表头进 t()，字段名只用来取值。
// INTENT: 之前表头直接印响应的 camelCase 字段名（latencyP50Ms / unlimitedMessages），
//         中文环境下整张表的表头都是英文变量名——DataTable 会 t(header)，但 t("latencyMs") 没有译文。
type ColumnSpec = readonly (readonly [field: string, header: string])[];
const tableColumns: Record<Exclude<ChatOpsAuthority, "overview">, ColumnSpec> = {
  providers: [
    ["provider", "Provider"],
    ["adapter", "Adapter"],
    ["status", "Status"],
    ["ok", "Reachable"],
    ["model", "Model"],
    ["endpoint", "Endpoint"],
    ["latencyMs", "Latency (ms)"],
    ["httpStatus", "HTTP status"],
    ["modelListed", "Model listed"],
    ["error", "Error"],
  ],
  usage: [
    ["userId", "User"],
    ["modelTier", "Model tier"],
    ["unlimitedMessages", "Unlimited"],
    ["messagesUsed", "Messages used"],
    ["freeDailyLimit", "Free daily limit"],
    ["freeRemaining", "Free remaining"],
    ["quotaStatus", "Quota status"],
    ["activeSessions", "Active sessions"],
    ["messages24h", "Messages 24h"],
    ["periodStart", "Period start"],
  ],
  sessions: [
    ["id", "Session"],
    ["userId", "User"],
    ["characterId", "Character"],
    ["title", "Title"],
    ["status", "Status"],
    ["memoryEnabled", "Memory"],
    ["messageCount", "Messages"],
    ["lastMessageRole", "Last role"],
    ["lastMessageStatus", "Last message status"],
    ["lastSafetyStatus", "Last safety status"],
    ["lastMessageAt", "Last message"],
  ],
  events: [
    ["id", "Event"],
    ["targetType", "Target type"],
    ["targetId", "Target"],
    ["layer", "Layer"],
    ["status", "Status"],
    ["policyCode", "Policy code"],
    ["confidence", "Confidence"],
    ["createdAt", "Created"],
  ],
};

// 这些列装的是枚举，走 value()/zhValues 通道；其余列是自由文本或数字，原样呈现。
const ENUM_COLUMNS: ReadonlySet<string> = new Set([
  "status",
  "quotaStatus",
  "layer",
  "lastMessageRole",
  "lastMessageStatus",
  "lastSafetyStatus",
  "targetType",
]);

function AuthorityTable({
  authority,
  empty,
  rows,
  state,
}: {
  authority: Exclude<ChatOpsAuthority, "overview">;
  empty: string;
  rows: Row[];
  state: AuthorityState;
}) {
  const { t, value: enumLabel } = useAdminI18n();
  if (!state.data && state.loading)
    return <Loading authority={AUTHORITY_LABELS[authority]} state={state} />;
  if (!state.data) return null;
  if (!rows.length)
    return (
      <EmptyState
        hint={t("The Chat Service authority returned no records.")}
        title={t(empty)}
      />
    );
  const columns = tableColumns[authority];
  return (
    <DataTable
      caption={
        authority === "providers"
          ? "Chat provider health"
          : authority === "usage"
            ? "Chat usage and quota"
            : authority === "sessions"
              ? "Recent chat sessions (no plaintext)"
              : "Chat moderation events"
      }
      headers={columns.map(([, header]) => header)}
      rows={tableRows(rows, columns, authority, enumLabel)}
    />
  );
}

function tableRows(
  rows: Row[],
  columns: ColumnSpec,
  prefix: string,
  enumLabel: (key: string) => string,
): DataTableRow[] {
  return rows.map((row, index) => ({
    id: text(row.id) || `${prefix}-${index}`,
    cells: columns.map(([field]) => {
      const raw = row[field];
      return ENUM_COLUMNS.has(field) && typeof raw === "string" && raw
        ? enumLabel(raw)
        : display(raw);
    }),
  }));
}

function Pager({
  authority,
  label,
  navigate,
  pageInfo,
  query,
}: {
  authority: "sessions" | "usage" | "events";
  label: string;
  navigate: (query: ChatOpsQuery) => void;
  pageInfo: PageInfo;
  query: ChatOpsQuery;
}) {
  if (!pageInfo.hasNextPage || !pageInfo.endCursor) return null;
  const cursor =
    authority === "sessions"
      ? "sessionCursor"
      : authority === "usage"
        ? "usageCursor"
        : "eventCursor";
  return (
    <button
      className="inline-flex min-h-11 items-center gap-2 rounded border px-4 text-sm font-semibold"
      onClick={() => navigate({ ...query, [cursor]: pageInfo.endCursor ?? "" })}
      type="button"
    >
      <RefreshCcw className="h-4 w-4" />
      {label}
    </button>
  );
}

// authority 是内部代号；界面上要显示它的人话名字，也才能进 t() 词表。
const AUTHORITY_LABELS: Record<ChatOpsAuthority, string> = {
  overview: "Overview",
  providers: "Provider health",
  sessions: "Sessions",
  usage: "Usage",
  events: "Events",
};

// SEAM: `state.error` 现在是后端原文。`ui/request-error-copy.ts` 落地后改走那套映射。
function AuthorityError({
  authority,
  query,
  retry,
  state,
}: {
  authority: ChatOpsAuthority;
  query: ChatOpsQuery;
  retry: (query: ChatOpsQuery, authority: ChatOpsAuthority) => Promise<void>;
  state: AuthorityState;
}) {
  const { t } = useAdminI18n();
  if (!state.error) return null;
  const label = t(AUTHORITY_LABELS[authority]);
  return (
    <div
      className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
      role="alert"
    >
      {t("{authority} authority refresh failed:", { authority: label })} {state.error}
      <button
        className="ml-3 min-h-8 rounded border border-current px-2"
        onClick={() => void retry(query, authority)}
        type="button"
      >
        {t("Retry {authority}", { authority: label })}
      </button>
      {state.data ? (
        <span className="ml-2">
          {t("The last good snapshot remains visible.")}
        </span>
      ) : null}
    </div>
  );
}

function DiagnosticsNotice({ data }: { data: ChatResponse | null }) {
  const { t } = useAdminI18n();
  if (!data || data.configured) return null;
  const diagnostics = data.diagnostics;
  return (
    <p
      className="rounded-md bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
      role="status"
    >
      {diagnostics?.reason === "upstream_error"
        ? t("Chat Service returned an upstream error ({status}).", { status: diagnostics.status ?? t("unknown") })
        : t(diagnosticKey(diagnostics))}
    </p>
  );
}

function diagnosticKey(diagnostics: Diagnostics | undefined) {
  if (!diagnostics || diagnostics.reason === "missing_url")
    return "Chat Service is not connected: CHAT_SERVICE_URL is missing.";
  if (diagnostics.reason === "unauthorized")
    return "Chat Service rejected the internal admin token.";
  if (diagnostics.reason === "bad_json")
    return "Chat Service returned invalid JSON.";
  return "Chat Service is configured but unreachable.";
}

function Freshness({
  authority,
  state,
}: {
  authority: string;
  state: AuthorityState;
}) {
  const { locale, t } = useAdminI18n();
  const label = t(authority);
  const time = state.refreshedAt
    ? new Date(state.refreshedAt).toLocaleTimeString(adminDateLocale(locale))
    : t("unknown");
  if (state.loading && state.data)
    return (
      <span>
        {label}
        {t(": refreshing · as of")} {time}
      </span>
    );
  if (state.error && state.data)
    return (
      <span>
        {label}
        {t(": stale · last good")} {time}
      </span>
    );
  if (state.error)
    return (
      <span>
        {label}
        {t(": unavailable")}
      </span>
    );
  if (state.data)
    return (
      <span>
        {label}
        {t(": as of")} {time}
      </span>
    );
  return (
    <span>
      {label}
      {t(": loading…")}
    </span>
  );
}

function Loading({
  authority,
  state,
}: {
  authority: string;
  state: AuthorityState;
}) {
  const { t } = useAdminI18n();
  return !state.data && state.loading ? (
    <div className="rounded-lg border p-4" role="status">
      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
      {t("Loading {authority} authority", { authority: t(authority) })}
    </div>
  ) : null;
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
        className="min-h-11 rounded-md border px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function Select({
  label,
  numeric = false,
  onChange,
  options,
  value,
}: {
  label: string;
  /** 行数这类纯数字选项不进枚举词表。 */
  numeric?: boolean;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  const { t, value: enumLabel } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {t(label)}
      <select
        className="min-h-11 rounded-md border px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {numeric ? option : enumLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function sessionFiltered(query: ChatOpsQuery) {
  return Boolean(
    query.userId || query.characterId || query.sessionStatus !== "all",
  );
}

function eventFiltered(query: ChatOpsQuery) {
  return Boolean(
    query.eventStatus !== "all" ||
    query.eventLayer !== "all" ||
    query.policyCode ||
    query.targetId,
  );
}

function currentQuery() {
  return typeof window === "undefined"
    ? defaultChatOpsQuery
    : chatOpsQueryFromSearch(window.location.search);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function display(value: unknown) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  return value === null || value === undefined ? "—" : JSON.stringify(value);
}

function date(value: unknown, locale: "en" | "zh") {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString(adminDateLocale(locale));
}
