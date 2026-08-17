"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import type { MetricDashboardResponse } from "@idream/shared/admin";
import { ExternalLink } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { AuthorityRequestError } from "@/components/admin/ui/AuthorityRequestError";
import { DataTable, type DataTableRow } from "@/components/admin/ui/DataTable";
import { EmptyState } from "@/components/admin/ui/EmptyState";
import { text, useAdminFormat } from "@/components/admin/ui/format";
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
  /** 原始异常 —— 文案与技术详情都由 ui/request-error-copy.ts 从错误码推。 */
  error: Error | null;
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
        purpose={t("Compare certified product metrics with separately sourced legacy operational diagnostics.")}
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
            columns={[["anonymousId", "Device"], ["accountCount", "Accounts"], ["userIds", "Users"]]}
            rows={data.deviceClusters}
            truncatedTo={20}
            caption="Multi-account device clusters"
          />
          <Rows
            columns={[["inviterId", "Inviter"], ["referralCount", "Referrals"]]}
            rows={data.referralAbuse}
            truncatedTo={20}
            caption="Referral farming (≥3 invites)"
          />
          <Rows
            columns={[["userId", "User"], ["count", "Adjustments"], ["totalDelta", "Net delta"]]}
            rows={data.adjustAnomalies}
            truncatedTo={20}
            caption="Manual adjust anomalies"
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
      endpoint="/api/v2/admin/ops/providers"
      permission="ops.queue.read"
      /* 只读总览必须给出口：改路由在 Profiles & Rollout，重放失败请求在 Dead-letter。 */
      actions={
        <WhereToAct
          links={[
            ["/admin/ops/profiles", "Change provider routing in Profiles & Rollout"],
            ["/admin/ops/jobs?view=dead-letter", "Triage the failed requests in Dead-letter"],
          ]}
        />
      }
      purpose="Compare provider success, cost, and completion latency over a server-defined time window."
      render={(data) => (
        <>
          <Window window={data.window} />
          <Rows
            columns={[
              ["provider", "Provider"],
              ["total", "Total"],
              ["completed", "Completed"],
              ["failed", "Failed"],
              ["blocked", "Blocked"],
              ["successRate", "Success rate %"],
              ["coinsCost", "Coins cost"],
              ["avgCostPerJob", "Avg cost / request"],
              ["latencyP50Ms", "Latency p50 (ms)"],
              ["latencyP95Ms", "Latency p95 (ms)"],
              ["latencySamples", "Latency samples"],
            ]}
            rows={data.providers}
            caption="Provider health & cost"
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
  actions,
  endpoint,
  permission,
  purpose,
  render,
  scope,
  title,
}: {
  canRead: boolean;
  /** 只读总览的出口：把运营送到真正能改东西的域。 */
  actions?: ReactNode;
  endpoint: string;
  permission: string;
  purpose: string;
  render: (data: T) => ReactNode;
  scope: OverviewScope;
  title: string;
}) {
  const { t } = useAdminI18n();
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
      <PageHeader purpose={t(purpose)} title={title} />
      <FreshnessLine entries={[[title, state, true]]} />
      <WindowForm draft={draft} onChange={setDraft} onSubmit={navigate} />
      <AuthorityError error={state.error} onRetry={() => void load(query)} />
      {state.data ? render(state.data) : null}
      {state.data ? actions : null}
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
        // 非 Error 的抛出物没有错误码可映射，就用调用点的兜底句子当 authority 原文。
        error: cause instanceof Error ? cause : new Error(fallback),
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

// SPEC: 值班场景要的是"最近一小时"，不是"某一天"。
// INTENT: 之前只有两个 type="date" 输入、服务端默认 30 天窗口——事故正在发生时，运营没有任何办法
//         把这几张表收敛到事故窗口，30 天的均值会把一小时的崩盘完全抹平。
const WINDOW_PRESETS: ReadonlyArray<readonly [label: string, ms: number]> = [
  ["Last hour", 60 * 60 * 1000],
  ["Last 24 hours", 24 * 60 * 60 * 1000],
  ["Last 7 days", 7 * 24 * 60 * 60 * 1000],
  ["Last 30 days", 30 * 24 * 60 * 60 * 1000],
];

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
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("Window presets")}>
        {WINDOW_PRESETS.map(([label, ms]) => (
          <button
            className="h-10 rounded-md border border-[var(--ad-border)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
            key={label}
            onClick={() => onSubmit({ from: new Date(Date.now() - ms).toISOString(), to: "" })}
            type="button"
          >
            {t(label)}
          </button>
        ))}
      </div>
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
        className="h-10 rounded-md bg-[var(--ad-ink)] px-4 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
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
  const { t } = useAdminI18n();
  return (
    <label className="grid gap-1 text-xs font-medium text-[var(--ad-text-muted)]">
      {t(label)}
      <input
        className="h-10 rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 text-sm"
        onChange={(event) => onChange(localInputToIso(event.target.value))}
        type="datetime-local"
        value={isoToLocalInput(value)}
      />
    </label>
  );
}

// INVARIANT: URL / 请求里始终是绝对时刻（ISO）。输入框收的是本地时间字符串——转换只发生在这个边界，
// 免得把"没有时区的本地串"直接送到服务端由 Node 按它自己的时区再解释一遍。
function localInputToIso(value: string) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function isoToLocalInput(value: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset() * 60 * 1000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
}

function CanonicalMetrics({ data }: { data: MetricDashboardResponse }) {
  const { t, value } = useAdminI18n();
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h2 className="text-sm font-semibold">{t("Canonical Metrics v2")}</h2>
      <p className="mt-1 text-xs text-[var(--ad-text-muted)]">

        {t("asOf")} <FormattedDate value={data.asOf} /> · {value(data.freshness)}
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
              {value(card.qualityState)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LegacyAnalytics({ data }: { data: AnalyticsData }) {
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
        columns={[["reason", "Reason"], ["totalDelta", "Net delta"], ["count", "Entries"]]}
        rows={data.economy.byReason}
        caption="Coin economy by reason"
      />
      <Rows
        columns={[["name", "Event"], ["count", "Count"]]}
        rows={data.topEvents}
        truncatedTo={20}
        caption="Top events"
      />
      {/* 失败与拦截数字就摆在这里，但处置它们的队列在另一个工作台，之前没有任何入口。 */}
      {data.generation.failed > 0 || data.generation.blocked > 0 ? (
        <WhereToAct links={[["/admin/ops/jobs?view=dead-letter", "Triage the failed and blocked requests in Dead-letter"]]} />
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  const { t } = useAdminI18n();
  return (
    <div className="rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <p className="text-xs text-[var(--ad-text-muted)]">{t(label)}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

// `title` 是未翻译的 key：DataTable 的 caption 与 EmptyState 各自过一次 t()。
// INTENT: 之前 title 传的是已翻译文案，再被 DataTable t() 一次；空态还把 title.toLowerCase()
//         当 key 喂给 t()——动态字符串进词表，中文永远查不中。
function Rows({
  caption,
  columns,
  rows,
  truncatedTo,
}: {
  caption: string;
  columns: readonly (readonly [field: string, header: string])[];
  rows: Row[];
  /** 服务端 slice/take 的上限。给了就如实标出来——满页时这不是全量。 */
  truncatedTo?: number;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  const tableRows: DataTableRow[] = rows.map((row, index) => ({
    id: text(row.id) || `${caption}-${index}`,
    cells: columns.map(([field]) => customerLinks(row[field], field) ?? format.display(row[field])),
  }));
  return (
    <>
      <DataTable
        caption={caption}
        empty={<EmptyState hint={t("The authority returned no rows for this window.")} title={t(caption)} />}
        headers={columns.map(([, header]) => header)}
        rows={tableRows}
      />
      {truncatedTo !== undefined && rows.length >= truncatedTo ? (
        <p className="mt-2 text-xs text-[var(--ad-text-muted)]">
          {t("Ranked list · the authority returns at most {count} rows, so this is not the full set.", { count: truncatedTo })}
        </p>
      ) : null}
    </>
  );
}

function FreshnessLine({
  entries,
}: {
  entries: Array<[string, State<unknown>, boolean]>;
}) {
  const { t } = useAdminI18n();
  const format = useAdminFormat();
  return (
    <div
      className="flex flex-wrap gap-3 text-xs text-[var(--ad-text-muted)]"
      role="status"
    >
      {entries
        .filter(([, , enabled]) => enabled)
        .map(([label, state]) => (
          <span key={label}>
            {t(label)}:{" "}
            {state.loading
              ? t("refreshing")
              : state.error
                ? t("stale · retry available")
                : t("fresh {time}", { time: state.refreshedAt ? format.time(state.refreshedAt) : "" })}
          </span>
        ))}
    </div>
  );
}

// 三个总览工作台都无条件渲染它，所以空值判断留在这里，别让每个调用点各写一次三元。
function AuthorityError({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  if (!error) return null;
  return <AuthorityRequestError cause={error} message={error.message} onRetry={onRetry} />;
}

function NoPermission({
  permission,
  title,
}: {
  permission: string;
  title: string;
}) {
  const { t } = useAdminI18n();
  return (
    <section className="space-y-5">
      <PageHeader
        purpose={t("This authority is not available to the current operator.")}
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

      {t("Window")} <FormattedDate value={window.from} /> → <FormattedDate value={window.to} />
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

function FormattedDate({ value }: { value: string }) {
  const format = useAdminFormat();
  return <>{format.dateTime(value)}</>;
}

// SPEC: 只读总览的固定出口块——写权限属于别的域，这里只负责把人送过去。
function WhereToAct({ links }: { links: ReadonlyArray<readonly [href: string, label: string]> }) {
  const { t } = useAdminI18n();
  return (
    <nav aria-label={t("Where to act")} className="flex flex-wrap gap-4 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface-subtle)] p-4 text-sm">
      {links.map(([href, label]) => (
        <a
          className="inline-flex items-center gap-2 font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
          href={href}
          key={href}
        >
          <ExternalLink className="h-4 w-4" />{t(label)}
        </a>
      ))}
    </nav>
  );
}

// SPEC: 风险信号里的账号 id 直接进客户详情。
// INTENT: 后端 abuse.ts 明确写了"处置动作留在各自的来源域"——它只报信号。既然如此，
//         界面至少得把人送到能处置的地方，而不是让运营把 id 复制粘贴到另一个工作台。
const CUSTOMER_ID_COLUMNS: ReadonlySet<string> = new Set(["userId", "inviterId", "userIds"]);

// 只剩「账号 id 变成链接」这一条本地规则；其余取值与缺失显示交给 ui/format 的 display。
function customerLinks(value: unknown, column: string) {
  if (!CUSTOMER_ID_COLUMNS.has(column)) return null;
  const ids = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" && value ? [value] : [];
  if (ids.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <a
          className="font-mono underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ad-ink)]"
          href={`/admin/customers/${encodeURIComponent(id)}`}
          key={id}
        >
          {id}
        </a>
      ))}
    </span>
  );
}

function initialState<T>(): State<T> {
  return { data: null, loading: true, error: null, refreshedAt: null };
}
