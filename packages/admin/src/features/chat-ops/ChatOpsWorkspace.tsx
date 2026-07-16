"use client";

import { Loader2, RefreshCcw, RotateCcw, Search } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
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

export function ChatOpsWorkspace({ canRead }: { canRead: boolean }) {
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

  const connected = authorities.some(
    (authority) => states[authority].data?.configured,
  );
  const overview = states.overview.data?.overview ?? null;
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Inspect Chat Service health, session metadata, quota usage, and moderation events without exposing message plaintext."
        title="Chat Ops"
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
          <strong>No access · chat.ops.read is not granted</strong>
        ) : (
          <strong>
            {connected
              ? "Chat Service connected"
              : "Chat Service degraded or disconnected"}
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
            Filter Chat Ops
          </button>
          <button
            className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4 text-sm"
            onClick={() => navigate(defaultChatOpsQuery)}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </button>
        </div>
      </form>
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
            <Loading authority="overview" state={states.overview} />
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
            empty={
              sessionFiltered(query)
                ? "No chat sessions match these filters"
                : "No chat sessions exist yet"
            }
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

export function ChatOpsOverviewCards({ overview }: { overview: Row | null }) {
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
          <p className="text-xs text-[var(--ad-text-muted)]">{String(label)}</p>
          <p className="mt-2 text-2xl font-semibold">
            {typeof value === "number" ? value : "—"}
          </p>
        </div>
      ))}
    </div>
  );
}

const tableColumns: Record<Exclude<ChatOpsAuthority, "overview">, string[]> = {
  providers: [
    "provider",
    "adapter",
    "status",
    "ok",
    "model",
    "endpoint",
    "latencyMs",
    "httpStatus",
    "modelListed",
    "error",
  ],
  usage: [
    "userId",
    "modelTier",
    "unlimitedMessages",
    "messagesUsed",
    "freeDailyLimit",
    "freeRemaining",
    "quotaStatus",
    "activeSessions",
    "messages24h",
    "periodStart",
  ],
  sessions: [
    "id",
    "userId",
    "characterId",
    "title",
    "status",
    "memoryEnabled",
    "messageCount",
    "lastMessageRole",
    "lastMessageStatus",
    "lastSafetyStatus",
    "lastMessageAt",
  ],
  events: [
    "id",
    "targetType",
    "targetId",
    "layer",
    "status",
    "policyCode",
    "confidence",
    "createdAt",
  ],
};

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
  if (!state.data && state.loading)
    return <Loading authority={authority} state={state} />;
  if (!state.data) return null;
  if (!rows.length)
    return (
      <EmptyState
        hint="The Chat Service authority returned no records."
        title={empty}
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
      headers={columns}
      rows={tableRows(rows, columns, authority)}
    />
  );
}

function tableRows(
  rows: Row[],
  columns: string[],
  prefix: string,
): DataTableRow[] {
  return rows.map((row, index) => ({
    id: text(row.id) || `${prefix}-${index}`,
    cells: columns.map((column) => display(row[column])),
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
  if (!state.error) return null;
  return (
    <div
      className="rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
      role="alert"
    >
      {authority} authority refresh failed: {state.error}
      <button
        className="ml-3 min-h-8 rounded border border-current px-2"
        onClick={() => void retry(query, authority)}
        type="button"
      >
        Retry {authority}
      </button>
      {state.data ? (
        <span className="ml-2">The last good snapshot remains visible.</span>
      ) : null}
    </div>
  );
}

function DiagnosticsNotice({ data }: { data: ChatResponse | null }) {
  if (!data || data.configured) return null;
  return (
    <p
      className="rounded-md bg-[var(--ad-yellow-bg)] p-3 text-sm text-[var(--ad-yellow-text)]"
      role="status"
    >
      {diagnosticText(data.diagnostics)}
    </p>
  );
}

function diagnosticText(diagnostics: Diagnostics | undefined) {
  if (!diagnostics || diagnostics.reason === "missing_url")
    return "Chat Service is not connected: CHAT_SERVICE_URL is missing.";
  if (diagnostics.reason === "unauthorized")
    return "Chat Service rejected the internal admin token.";
  if (diagnostics.reason === "bad_json")
    return "Chat Service returned invalid JSON.";
  if (diagnostics.reason === "upstream_error")
    return `Chat Service returned an upstream error${diagnostics.status ? ` (${diagnostics.status})` : ""}.`;
  return "Chat Service is configured but unreachable.";
}

function Freshness({
  authority,
  state,
}: {
  authority: string;
  state: AuthorityState;
}) {
  const time = state.refreshedAt
    ? new Date(state.refreshedAt).toLocaleTimeString()
    : "unknown";
  if (state.loading && state.data)
    return (
      <span>
        {authority}: refreshing · showing snapshot from {time}
      </span>
    );
  if (state.error && state.data)
    return (
      <span>
        {authority}: stale · last good {time}
      </span>
    );
  if (state.error) return <span>{authority}: unavailable</span>;
  if (state.data)
    return (
      <span>
        {authority}: current client snapshot · {time}
      </span>
    );
  return <span>{authority}: refreshing · no snapshot yet</span>;
}

function Loading({
  authority,
  state,
}: {
  authority: string;
  state: AuthorityState;
}) {
  return !state.data && state.loading ? (
    <div className="rounded-lg border p-4" role="status">
      <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
      Loading {authority} authority
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
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--ad-text-muted)]">
      {label}
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
        className="min-h-11 rounded-md border px-3 text-sm"
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
