"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { MetricDashboardResponse } from "@idream/shared/admin";
import { RefreshCcw } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { PageHeader } from "@/components/admin/ui/PageHeader";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { createLatestRequestGate } from "@/lib/latest-request";
import {
  overviewPath,
  overviewQueryFromSearch,
  overviewWorkspaceUrl,
  type OverviewQuery,
  type OverviewScope,
} from "./query";

type Row = Record<string, unknown>;
type AnalyticsData = {
  window: { from: string; to: string };
  funnel: { signups: number; payingUsers: number | null };
  generation: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
  };
  economy: { coinsGranted: number; net: number; byReason: Row[] };
  topEvents: Row[];
};
type RiskData = {
  window: { from: string; to: string };
  deviceClusters: Row[];
  referralAbuse: Row[];
  adjustAnomalies: Row[];
};
type ProviderData = {
  window: { from: string; to: string };
  providers: Row[];
};
type State<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refreshedAt: string | null;
};

export function AnalyticsWorkspace({
  canReadCanonical,
  canReadLegacy,
}: {
  canReadCanonical: boolean;
  canReadLegacy: boolean;
}) {
  const { t } = useAdminI18n();
  const [query, setQuery] = useState(() => currentQuery("analytics"));
  const [draft, setDraft] = useState(query);
  const [canonical, setCanonical] =
    useState<State<MetricDashboardResponse>>(initialState);
  const [legacy, setLegacy] = useState<State<AnalyticsData>>(initialState);
  const canonicalGate = useRef(createLatestRequestGate());
  const legacyGate = useRef(createLatestRequestGate());

  const loadCanonical = useCallback(async () => {
    if (!canReadCanonical) return;
    await loadState(
      canonicalGate.current,
      setCanonical,
      "/api/v2/admin/metrics",
      "Canonical metrics could not be loaded",
    );
  }, [canReadCanonical]);
  const loadLegacy = useCallback(
    async (next: OverviewQuery) => {
      if (!canReadLegacy) return;
      await loadState(
        legacyGate.current,
        setLegacy,
        overviewPath("/api/v2/admin/analytics/overview", next),
        "Legacy analytics could not be loaded",
      );
    },
    [canReadLegacy],
  );

  useAuthorityLifecycle(
    "analytics",
    query,
    setQuery,
    setDraft,
    () => {
      void loadCanonical();
      void loadLegacy(currentQuery("analytics"));
    },
    [canonicalGate, legacyGate],
  );

  function navigate(next: OverviewQuery) {
    pushQuery("analytics", next);
    setQuery(next);
    setDraft(next);
    void loadLegacy(next);
  }

  if (!canReadCanonical && !canReadLegacy) {
    return <NoPermission title={t("Product Health")} permission="metrics.read" />;
  }
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="Compare certified product metrics with separately sourced legacy operational diagnostics."
        title={t("Product Health")}
      />
      <FreshnessLine
        entries={[
          ["Canonical", canonical, canReadCanonical],
          ["Legacy", legacy, canReadLegacy],
        ]}
      />
      <WindowForm draft={draft} onChange={setDraft} onSubmit={navigate} />
      <AuthorityError
        error={canonical.error}
        onRetry={() => void loadCanonical()}
      />
      {canonical.data ? <CanonicalMetrics data={canonical.data} /> : null}
      {!canReadCanonical ? <PermissionNote permission="metrics.read" /> : null}
      <AuthorityError
        error={legacy.error}
        onRetry={() => void loadLegacy(query)}
      />
      {legacy.data ? <LegacyAnalytics data={legacy.data} /> : null}
      {!canReadLegacy ? <PermissionNote permission="analytics.export" /> : null}
    </section>
  );
}

export function RiskWorkspace({ canRead }: { canRead: boolean }) {
  const { t } = useAdminI18n();
  return (
    <SingleOverview<RiskData>
      canRead={canRead}
      endpoint="/api/v2/admin/risk/abuse"
      permission="billing.read"
      purpose="Inspect owner-scoped financial abuse signals while keeping response actions in their source domains."
      render={(data) => (
        <>
          <Window window={data.window} />
          <Rows
            columns={["anonymousId", "accountCount", "userIds"]}
            rows={data.deviceClusters}
            title={t("Multi-account device clusters")}
          />
          <Rows
            columns={["inviterId", "referralCount"]}
            rows={data.referralAbuse}
            title={t("Referral farming (≥3 invites)")}
          />
          <Rows
            columns={["userId", "count", "totalDelta"]}
            rows={data.adjustAnomalies}
            title={t("Manual adjust anomalies")}
          />
        </>
      )}
      scope="risk"
      title={t("Risk Cases")}
    />
  );
}

export function ProviderOverviewWorkspace({ canRead }: { canRead: boolean }) {
  const { t } = useAdminI18n();
  return (
    <SingleOverview<ProviderData>
      canRead={canRead}
      endpoint="/api/v1/admin/ops/providers"
      permission="ops.queue.read"
      purpose="Compare provider success, cost, and completion latency over a server-defined time window."
      render={(data) => (
        <>
          <Window window={data.window} />
          <Rows
            columns={[
              "provider",
              "total",
              "completed",
              "failed",
              "blocked",
              "successRate",
              "coinsCost",
              "avgCostPerJob",
              "latencyP50Ms",
              "latencyP95Ms",
              "latencySamples",
            ]}
            rows={data.providers}
            title={t("Provider health & cost")}
          />
        </>
      )}
      scope="provider"
      title={t("Providers")}
    />
  );
}

function SingleOverview<T>({
  canRead,
  endpoint,
  permission,
  purpose,
  render,
  scope,
  title,
}: {
  canRead: boolean;
  endpoint: string;
  permission: string;
  purpose: string;
  render: (data: T) => ReactNode;
  scope: OverviewScope;
  title: string;
}) {
  const [query, setQuery] = useState(() => currentQuery(scope));
  const [draft, setDraft] = useState(query);
  const [state, setState] = useState<State<T>>(initialState);
  const gate = useRef(createLatestRequestGate());
  const load = useCallback(
    async (next: OverviewQuery) => {
      if (!canRead) return;
      await loadState(
        gate.current,
        setState,
        overviewPath(endpoint, next),
        `${title} could not be loaded`,
      );
    },
    [canRead, endpoint, title],
  );
  useAuthorityLifecycle(
    scope,
    query,
    setQuery,
    setDraft,
    () => void load(currentQuery(scope)),
    [gate],
  );

  function navigate(next: OverviewQuery) {
    pushQuery(scope, next);
    setQuery(next);
    setDraft(next);
    void load(next);
  }

  if (!canRead) return <NoPermission permission={permission} title={title} />;
  return (
    <section className="space-y-5">
      <PageHeader purpose={purpose} title={title} />
      <FreshnessLine entries={[[title, state, true]]} />
      <WindowForm draft={draft} onChange={setDraft} onSubmit={navigate} />
      <AuthorityError error={state.error} onRetry={() => void load(query)} />
      {state.data ? render(state.data) : null}
    </section>
  );
}

async function loadState<T>(
  gate: ReturnType<typeof createLatestRequestGate>,
  setState: (value: State<T> | ((current: State<T>) => State<T>)) => void,
  path: string,
  fallback: string,
) {
  const request = gate.begin();
  setState((current) => ({ ...current, loading: true, error: null }));
  try {
    const data = await apiGet<T>(path);
    if (request.isCurrent())
      setState({
        data,
        loading: false,
        error: null,
        refreshedAt: new Date().toISOString(),
      });
  } catch (cause) {
    if (request.isCurrent())
      setState((current) => ({
        ...current,
        loading: false,
        error: cause instanceof Error ? cause.message : fallback,
      }));
  }
}

function useAuthorityLifecycle(
  scope: OverviewScope,
  query: OverviewQuery,
  setQuery: (value: OverviewQuery) => void,
  setDraft: (value: OverviewQuery) => void,
  load: () => void,
  gates: Array<{
    current: ReturnType<typeof createLatestRequestGate>;
  }>,
) {
  const initialLoad = useRef(load);
  useEffect(() => {
    initialLoad.current();
    const restore = () => {
      const next = currentQuery(scope);
      setQuery(next);
      setDraft(next);
      load();
    };
    window.addEventListener("popstate", restore);
    window.addEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    return () => {
      for (const gate of gates) gate.current.invalidate();
      window.removeEventListener("popstate", restore);
      window.removeEventListener(ADMIN_WORKSPACE_REFRESH_EVENT, restore);
    };
    // Authority setup is stable for a mounted route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  void query;
}

function WindowForm({
  draft,
  onChange,
  onSubmit,
}: {
  draft: OverviewQuery;
  onChange: (value: OverviewQuery) => void;
  onSubmit: (value: OverviewQuery) => void;
}) {
  const { t } = useAdminI18n();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(draft);
  }
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4"
      onSubmit={submit}
    >
      <DateField
        label="From"
        onChange={(from) => onChange({ ...draft, from })}
        value={draft.from}
      />
      <DateField
        label="To"
        onChange={(to) => onChange({ ...draft, to })}
        value={draft.to}
      />
      <button
        className="h-10 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white"
        type="submit"
      >

        {t("Apply window")}
      </button>
      <button
        className="h-10 rounded-md border border-[var(--ad-border)] px-4 text-sm"
        onClick={() => onSubmit({ from: "", to: "" })}
        type="button"
      >

        {t("Reset")}
      </button>
    </form>
  );
}

function DateField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {label}
      <input
        className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(event.target.value)}
        type="date"
        value={value}
      />
    </label>
  );
}

function CanonicalMetrics({ data }: { data: MetricDashboardResponse }) {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("Canonical Metrics v2")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

        {t("asOf")} {formatDate(data.asOf)} · {data.freshness}
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.cards.map((card) => (
          <div
            className="rounded-md border border-[var(--ad-border)] p-3"
            key={card.key}
          >
            <p className="text-sm font-medium">{card.name}</p>
            <p className="mt-2 text-2xl font-semibold">
              {card.value === null
                ? "—"
                : card.unit === "ratio"
                  ? `${(Number(card.value) * 100).toFixed(1)}%`
                  : card.value}
            </p>
            <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
              v{card.definitionVersion}  {t("· sample")} {card.sampleSize} ·{" "}
              {card.qualityState}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LegacyAnalytics({ data }: { data: AnalyticsData }) {
  const { t } = useAdminI18n();
  return (
    <div className="space-y-4">
      <Window window={data.window} />
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Signups" value={data.funnel.signups} />
        <Metric label="Generations" value={data.generation.total} />
        <Metric label="Failed" value={data.generation.failed} />
        <Metric label="Coins net" value={data.economy.net} />
      </div>
      <Rows
        columns={["reason", "totalDelta", "count"]}
        rows={data.economy.byReason}
        title={t("Coin economy by reason")}
      />
      <Rows
        columns={["name", "count"]}
        rows={data.topEvents}
        title={t("Top events")}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <p className="text-xs text-[var(--ad-text-muted)]">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function Rows({
  columns,
  rows,
  title,
}: {
  columns: string[];
  rows: Row[];
  title: string;
}) {
  const { t } = useAdminI18n();
  const tableRows: DataTableRow[] = rows.map((row, index) => ({
    id: stringValue(row.id) || `${title}-${index}`,
    cells: columns.map((column) => cell(row[column])),
  }));
  return (
    <DataTable
      caption={title}
      empty={<EmptyState title={t("No {title}", { title: t(title.toLowerCase()) })} />}
      headers={columns}
      rows={tableRows}
    />
  );
}

function FreshnessLine({
  entries,
}: {
  entries: Array<[string, State<unknown>, boolean]>;
}) {
  const { t } = useAdminI18n();
  return (
    <div
      className="flex flex-wrap gap-3 text-xs text-[var(--ad-text-muted)]"
      role="status"
    >
      {entries
        .filter(([, , enabled]) => enabled)
        .map(([label, state]) => (
          <span key={label}>
            {label}:{" "}
            {state.loading
              ? t("refreshing")
              : state.error
                ? t("stale · retry available")
                : t("fresh {time}", { time: state.refreshedAt ? new Date(state.refreshedAt).toLocaleTimeString() : "" })}
          </span>
        ))}
    </div>
  );
}

function AuthorityError({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useAdminI18n();
  if (!error) return null;
  return (
    <div
      className="flex items-center justify-between rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]"
      role="alert"
    >
      <span>{error}</span>
      <button
        className="inline-flex min-h-9 items-center gap-2 rounded border px-3"
        onClick={onRetry}
        type="button"
      >
        <RefreshCcw className="h-4 w-4" />

        {t("Retry")}
      </button>
    </div>
  );
}

function NoPermission({
  permission,
  title,
}: {
  permission: string;
  title: string;
}) {
  return (
    <section className="space-y-5">
      <PageHeader
        purpose="This authority is not available to the current operator."
        title={title}
      />
      <PermissionNote permission={permission} />
    </section>
  );
}

function PermissionNote({ permission }: { permission: string }) {
  const { t } = useAdminI18n();
  return (
    <p className="rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 text-sm text-[var(--ad-text-muted)]">

      {t("No access ·")} {permission} {t("is not granted")}
    </p>
  );
}

function Window({ window }: { window: { from: string; to: string } }) {
  const { t } = useAdminI18n();
  return (
    <p className="text-xs text-[var(--ad-text-muted)]">

      {t("Window")} {formatDate(window.from)} → {formatDate(window.to)}
    </p>
  );
}

function currentQuery(scope: OverviewScope) {
  return overviewQueryFromSearch(
    typeof window === "undefined" ? "" : window.location.search,
    scope,
  );
}

function pushQuery(scope: OverviewScope, query: OverviewQuery) {
  window.history.pushState(
    null,
    "",
    overviewWorkspaceUrl(
      window.location.pathname,
      window.location.search,
      scope,
      query,
    ),
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function cell(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return JSON.stringify(value);
}

function initialState<T>(): State<T> {
  return { data: null, loading: true, error: null, refreshedAt: null };
}
