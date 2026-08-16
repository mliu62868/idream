"use client";

// SPEC: generation metrics 决策面板 —— 顶部四个结论指标（产量 / 失败率 / 花费 / 铺位 CTR）
//       带同比，下面五张按"最该处理的排最前"排序的明细表，失败单元格直通 Generation Jobs。
// INTENT: selfFetch 模式镜像 BackendsView.tsx；纯只读，无写操作。
// WHY(同比): 接口只认"最近 N 天"，没有 offset。上一窗口 = 请求 2N 天再减去当前 N 天——
//   对可加字段（次数 / 花费 / 曝光 / 点击）这是精确的；平均时长不可减，所以不做同比。
//   2N 天那一发失败时就不显示同比，绝不用当前值冒充。
// WHY(排序): 服务端按 total 降序（谁量大）。运营要处理的是"哪儿坏得最多"，所以这里按失败数
//   降序、失败率降序兜底。纯按失败率会把 1/1=100% 顶到 500 次里失败 125 次的上面。
// INVARIANTS: avgDurationMs 渲染为 "x.x s"（null → "–"）；失败率 >20% 标红；失败数为 0 时
//   不给下钻链接（点进去必然是空列表）。

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, RefreshCcw } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { ReadonlyOpsView, type OpsColumn } from "@/components/admin/generation/ReadonlyOpsView";
import { cn } from "@/lib/utils";

type StatusBuckets = { total: number; completed: number; failed: number; blocked: number };

type ProfileMetric = StatusBuckets & {
  profileId: string;
  profileVersion: number | null;
  label: string | null;
  workflowKey: string | null;
  costDreamcoins: number;
  avgDurationMs: number | null;
};

type RecipeMetric = StatusBuckets & { recipeId: string; costDreamcoins: number };

type SourceMetric = StatusBuckets & { sourceType: string; costDreamcoins: number };

type PlacementMetric = { slot: string; status: string; count: number };

type PlacementEngagementMetric = {
  slot: string;
  placementId: string | null;
  impressions: number;
  clicks: number;
};

export type MetricsResponse = {
  windowDays: number;
  profiles: ProfileMetric[];
  recipes: RecipeMetric[];
  sources: SourceMetric[];
  placements: PlacementMetric[];
  placementEngagement: PlacementEngagementMetric[];
  remix: { total: number };
};

const WINDOW_OPTIONS = [7, 30] as const;
export type MetricsWindowDays = (typeof WINDOW_OPTIONS)[number];
type MetricsSnapshots = Partial<Record<MetricsWindowDays, MetricsResponse>>;
type MetricsWindowState<T> = Partial<Record<MetricsWindowDays, T>>;

const JOBS_PATH = "/admin/ops/jobs";

export function metricsSnapshotForWindow(
  snapshots: MetricsSnapshots,
  windowDays: MetricsWindowDays,
) {
  return snapshots[windowDays] ?? null;
}

export type MetricsWindowErrorMessage = {
  key: string;
  values: Record<string, string | number>;
};

// SPEC: 返回 i18n key + 插值，不返回成品句子——成品句子必然是英文，中文 locale 下会露馅。
export function metricsWindowErrorMessage(input: {
  error: string;
  requestedWindowDays: MetricsWindowDays;
  hasRequestedSnapshot: boolean;
  lastGoodWindowDays: MetricsWindowDays | null;
}): MetricsWindowErrorMessage {
  if (input.hasRequestedSnapshot) {
    return {
      key: "{error} Showing the last successfully loaded {days}-day snapshot.",
      values: { error: input.error, days: input.requestedWindowDays },
    };
  }
  if (
    input.lastGoodWindowDays !== null &&
    input.lastGoodWindowDays !== input.requestedWindowDays
  ) {
    return {
      key: "{error} {days}-day metrics are unavailable. The last successful snapshot was {lastGood} days and is not shown for this window.",
      values: {
        error: input.error,
        days: input.requestedWindowDays,
        lastGood: input.lastGoodWindowDays,
      },
    };
  }
  return {
    key: "{error} {days}-day metrics are unavailable.",
    values: { error: input.error, days: input.requestedWindowDays },
  };
}

export type WindowTotals = {
  total: number;
  failed: number;
  blocked: number;
  cost: number;
  impressions: number;
  clicks: number;
};

// SPEC: sources 按 sourceType 分组且 sourceType 非空，所以它——而不是 profiles/recipes
// （两者都丢掉 null 外键的行）——才是全量任务的口径。
export function windowTotals(metrics: MetricsResponse): WindowTotals {
  const jobs = metrics.sources.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      failed: sum.failed + row.failed,
      blocked: sum.blocked + row.blocked,
      cost: sum.cost + row.costDreamcoins,
    }),
    { total: 0, failed: 0, blocked: 0, cost: 0 },
  );
  const engagement = metrics.placementEngagement.reduce(
    (sum, row) => ({
      impressions: sum.impressions + row.impressions,
      clicks: sum.clicks + row.clicks,
    }),
    { impressions: 0, clicks: 0 },
  );
  return { ...jobs, ...engagement };
}

// SPEC: 上一窗口 = 双倍窗口 − 当前窗口。两次请求之间数据会继续写入，所以只要出现负值就
// 认定同比不可用——宁可不给趋势，也不给一个编出来的趋势。
export function previousWindowTotals(
  current: WindowTotals,
  doubled: WindowTotals,
): WindowTotals | null {
  const previous: WindowTotals = {
    total: doubled.total - current.total,
    failed: doubled.failed - current.failed,
    blocked: doubled.blocked - current.blocked,
    cost: doubled.cost - current.cost,
    impressions: doubled.impressions - current.impressions,
    clicks: doubled.clicks - current.clicks,
  };
  return Object.values(previous).some((value) => value < 0) ? null : previous;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function failureRate(buckets: StatusBuckets): number {
  if (buckets.total === 0) return 0;
  return buckets.failed / buckets.total;
}

function formatDuration(avgDurationMs: number | null): string {
  if (avgDurationMs === null) return "–";
  return `${(avgDurationMs / 1000).toFixed(1)} s`;
}

function formatPercent(value: number | null): string {
  return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

// SPEC: 先按失败数降序（要修的量），失败数相同再看失败率，最后才是产量。
function byFailureImpact<T extends StatusBuckets>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => b.failed - a.failed || failureRate(b) - failureRate(a) || b.total - a.total,
  );
}

export function GenerationMetricsView() {
  const { t, value } = useAdminI18n();
  const [windowDays, setWindowDays] = useState<MetricsWindowDays>(7);
  const [snapshots, setSnapshots] = useState<MetricsSnapshots>({});
  const [baselines, setBaselines] = useState<MetricsWindowState<WindowTotals | null>>({});
  const [loadingByWindow, setLoadingByWindow] = useState<
    MetricsWindowState<boolean>
  >({});
  const [errorsByWindow, setErrorsByWindow] = useState<
    MetricsWindowState<string | null>
  >({});
  const [lastGoodWindowDays, setLastGoodWindowDays] =
    useState<MetricsWindowDays | null>(null);
  const metrics = metricsSnapshotForWindow(snapshots, windowDays);
  const error = errorsByWindow[windowDays] ?? null;
  const loading =
    loadingByWindow[windowDays] ??
    (metrics === null && errorsByWindow[windowDays] === undefined);
  const errorMessage = error
    ? metricsWindowErrorMessage({
        error,
        requestedWindowDays: windowDays,
        hasRequestedSnapshot: metrics !== null,
        lastGoodWindowDays,
      })
    : null;

  const load = useCallback(async (days: MetricsWindowDays) => {
    setLoadingByWindow((current) => ({ ...current, [days]: true }));
    setErrorsByWindow((current) => ({ ...current, [days]: null }));
    try {
      const data = await apiGet<MetricsResponse>(`/api/v2/admin/generation/metrics?days=${days}`);
      if (data.windowDays !== days) {
        throw new Error(
          t("Metrics authority returned {returned} days for a {requested}-day request.", {
            returned: data.windowDays,
            requested: days,
          }),
        );
      }
      setSnapshots((current) => ({ ...current, [days]: data }));
      setLastGoodWindowDays(days);
      // 同比是加分项，不是这个页面的主体：拿不到就静默降级为"无同比"，不污染主错误条。
      try {
        const doubled = await apiGet<MetricsResponse>(
          `/api/v2/admin/generation/metrics?days=${days * 2}`,
        );
        setBaselines((current) => ({
          ...current,
          [days]: doubled.windowDays === days * 2
            ? previousWindowTotals(windowTotals(data), windowTotals(doubled))
            : null,
        }));
      } catch {
        setBaselines((current) => ({ ...current, [days]: null }));
      }
    } catch (err) {
      setErrorsByWindow((current) => ({
        ...current,
        [days]: err instanceof Error ? err.message : t("Request failed"),
      }));
    } finally {
      setLoadingByWindow((current) => ({ ...current, [days]: false }));
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(windowDays);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, windowDays]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("Metrics")}</h2>
        <div className="flex items-center gap-2">
          <div className="rounded-lg flex border border-[var(--ad-border)]">
            {WINDOW_OPTIONS.map((days) => (
              <button
                className={cn(
                  "h-9 px-3 text-sm",
                  windowDays === days ? "bg-black/[0.05]" : "opacity-70 hover:opacity-100",
                )}
                key={days}
                onClick={() => setWindowDays(days)}
                type="button"
              >
                {days} {t("days")}
              </button>
            ))}
          </div>
          <button
            className="rounded-md inline-flex h-9 items-center gap-2 border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50"
            disabled={loading}
            onClick={() => void load(windowDays)}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t("Refresh")}
          </button>
        </div>
      </div>
      {errorMessage ? (
        <p role="alert" className="text-xs text-[var(--ad-red-text)]">
          {t(errorMessage.key, errorMessage.values)}
        </p>
      ) : null}

      {metrics ? (
        <>
          <HeadlineBand
            baseline={baselines[windowDays] ?? null}
            current={windowTotals(metrics)}
            windowDays={windowDays}
          />
          <ProfilesTable profiles={metrics.profiles} />
          <RecipesTable recipes={metrics.recipes} />
          <SourcesTable sources={metrics.sources} />
          <ReadonlyOpsView
            columns={[
              { key: "slot", label: "Slot", render: (row) => <span className="font-mono">{value(String(row.slot))}</span> },
              { key: "status", label: "Status", render: (row) => value(String(row.status)) },
              { key: "count", label: "Count" },
            ]}
            empty={t("No generation records in window.")}
            rows={metrics.placements as unknown as Record<string, unknown>[]}
            title={t("Placements")}
          />
          <PlacementEngagementTable engagement={metrics.placementEngagement} />
          <RemixSection total={metrics.remix.total} />
        </>
      ) : (
        <MetricsAuthorityState loading={loading} />
      )}
    </div>
  );
}

function MetricsAuthorityState({ loading }: { loading: boolean }) {
  const { t } = useAdminI18n();
  return (
    <section
      aria-live="polite"
      className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 text-sm text-[var(--ad-text-muted)]"
      role="status"
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("Loading generation metrics…")}
        </span>
      ) : (
        t("Generation metrics are unavailable. No values are shown until the authority request succeeds.")
      )}
    </section>
  );
}

// SPEC: 四个能直接下结论的数：产量、失败率、花费、铺位 CTR，各带上一个等长窗口的同比。
function HeadlineBand({
  baseline,
  current,
  windowDays,
}: {
  baseline: WindowTotals | null;
  current: WindowTotals;
  windowDays: MetricsWindowDays;
}) {
  const { t } = useAdminI18n();
  const currentFailureRate = ratio(current.failed, current.total);
  const currentCtr = ratio(current.clicks, current.impressions);
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("Last {days} days", { days: windowDays })}</h3>
        <p className="text-xs text-[var(--ad-text-muted)]">
          {baseline
            ? t("Change is measured against the {days} days before this window.", { days: windowDays })
            : t("No comparison window is available, so no change is shown.")}
        </p>
      </div>
      <div className="mt-3 grid gap-px overflow-hidden rounded-md border border-[var(--ad-border)] bg-black/[0.05] sm:grid-cols-2 lg:grid-cols-4">
        <HeadlineTile
          delta={baseline ? countDelta(current.total, baseline.total) : null}
          label={t("Generations")}
          value={String(current.total)}
        />
        <HeadlineTile
          delta={baseline ? pointDelta(currentFailureRate, ratio(baseline.failed, baseline.total)) : null}
          higherIsWorse
          label={t("Failure rate")}
          tone={currentFailureRate !== null && currentFailureRate > 0.2 ? "bad" : undefined}
          value={formatPercent(currentFailureRate)}
        />
        <HeadlineTile
          delta={baseline ? countDelta(current.cost, baseline.cost) : null}
          higherIsWorse
          label={t("Total cost")}
          value={t("{cost} DC", { cost: current.cost })}
        />
        <HeadlineTile
          delta={baseline ? pointDelta(currentCtr, ratio(baseline.clicks, baseline.impressions)) : null}
          label={t("Placement CTR")}
          value={formatPercent(currentCtr)}
        />
      </div>
    </section>
  );
}

type Delta = { text: string; direction: "up" | "down" | "flat" };

function countDelta(current: number, previous: number): Delta {
  const change = current - previous;
  return {
    text: `${change > 0 ? "+" : ""}${change}`,
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
  };
}

function pointDelta(current: number | null, previous: number | null): Delta | null {
  if (current === null || previous === null) return null;
  const change = (current - previous) * 100;
  return {
    text: `${change > 0 ? "+" : ""}${change.toFixed(1)} pp`,
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
  };
}

function HeadlineTile({
  delta,
  higherIsWorse = false,
  label,
  tone,
  value,
}: {
  delta: Delta | null;
  higherIsWorse?: boolean;
  label: string;
  tone?: "bad";
  value: string;
}) {
  const worsening = delta !== null && delta.direction !== "flat"
    && (delta.direction === "up") === higherIsWorse;
  return (
    <div className="bg-[var(--ad-surface)] p-3">
      <p className="text-xs text-[var(--ad-text-muted)]">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "bad" && "text-[var(--ad-red-text)]")}>
        {value}
      </p>
      {delta ? (
        <p
          className={cn(
            "mt-0.5 text-xs tabular-nums",
            delta.direction === "flat"
              ? "text-[var(--ad-text-muted)]"
              : worsening
                ? "text-[var(--ad-red-text)]"
                : "text-[var(--ad-green-text)]",
          )}
        >
          {delta.text}
        </p>
      ) : null}
    </div>
  );
}

// SPEC: 失败数是链接不是数字——点进去就是这一行在同一窗口里的失败任务列表，原因在那儿。
function FailedCell({ buckets, jobsQuery }: { buckets: StatusBuckets; jobsQuery: string }) {
  const { t } = useAdminI18n();
  const rate = failureRate(buckets);
  const alarming = rate > 0.2;
  if (buckets.failed === 0) {
    return <span className="tabular-nums text-[var(--ad-text-muted)]">0</span>;
  }
  return (
    <Link
      className={cn(
        "font-semibold tabular-nums underline underline-offset-2",
        alarming ? "text-[var(--ad-red-text)]" : "text-[var(--ad-text)]",
      )}
      href={`${JOBS_PATH}?${jobsQuery}`}
      title={t("Open the failed generation jobs behind this number")}
    >
      {buckets.failed}
    </Link>
  );
}

function failedJobsQuery(filter: { search?: string; sourceType?: string }) {
  const params = new URLSearchParams({ mode: "all", legacyStatus: "failed" });
  if (filter.search) params.set("search", filter.search);
  if (filter.sourceType) params.set("sourceType", filter.sourceType);
  return params.toString();
}

function rateCell(buckets: StatusBuckets) {
  const rate = failureRate(buckets);
  return (
    <span className={cn("tabular-nums", rate > 0.2 && "text-[var(--ad-red-text)]")}>
      {formatPercent(buckets.total === 0 ? null : rate)}
    </span>
  );
}

function bucketsSummary(rows: readonly (StatusBuckets & { costDreamcoins: number })[], t: (key: string, values?: Record<string, string | number>) => string) {
  const totals = rows.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      failed: sum.failed + row.failed,
      cost: sum.cost + row.costDreamcoins,
    }),
    { total: 0, failed: 0, cost: 0 },
  );
  return t("{total} generations · {rate} failed · {cost} DC total", {
    total: totals.total,
    rate: formatPercent(ratio(totals.failed, totals.total)),
    cost: totals.cost,
  });
}

function ProfilesTable({ profiles }: { profiles: ProfileMetric[] }) {
  const { t } = useAdminI18n();
  const columns: OpsColumn[] = [
    { key: "label", label: "Label", render: (row) => (row.label as string | null) ?? "–" },
    {
      key: "profileId",
      label: "Profile",
      render: (row) => (
        <span className="font-mono">{row.profileId as string}@{(row.profileVersion as number | null) ?? 0}</span>
      ),
    },
    { key: "workflowKey", label: "Workflow", render: (row) => <span className="font-mono">{(row.workflowKey as string | null) ?? "–"}</span> },
    { key: "total", label: "Total" },
    { key: "completed", label: "Completed" },
    {
      key: "failed",
      label: "Failed",
      render: (row) => (
        <FailedCell
          buckets={row as unknown as StatusBuckets}
          jobsQuery={failedJobsQuery({ search: row.profileId as string })}
        />
      ),
    },
    { key: "failureRate", label: "Failure rate", render: (row) => rateCell(row as unknown as StatusBuckets) },
    { key: "blocked", label: "Blocked" },
    { key: "costDreamcoins", label: "Cost" },
    { key: "avgDurationMs", label: "Avg Duration", render: (row) => formatDuration(row.avgDurationMs as number | null) },
  ];
  return (
    <ReadonlyOpsView
      columns={columns}
      empty={t("No generation records in window.")}
      rows={byFailureImpact(profiles) as unknown as Record<string, unknown>[]}
      summary={profiles.length > 0 ? bucketsSummary(profiles, t) : null}
      title={t("Profiles")}
    />
  );
}

function RecipesTable({ recipes }: { recipes: RecipeMetric[] }) {
  const { t } = useAdminI18n();
  const columns: OpsColumn[] = [
    { key: "recipeId", label: "Recipe", render: (row) => <span className="font-mono">{row.recipeId as string}</span> },
    { key: "total", label: "Total" },
    { key: "completed", label: "Completed" },
    {
      key: "failed",
      label: "Failed",
      render: (row) => (
        <FailedCell
          buckets={row as unknown as StatusBuckets}
          jobsQuery={failedJobsQuery({ search: row.recipeId as string })}
        />
      ),
    },
    { key: "failureRate", label: "Failure rate", render: (row) => rateCell(row as unknown as StatusBuckets) },
    { key: "blocked", label: "Blocked" },
    { key: "costDreamcoins", label: "Cost" },
  ];
  return (
    <ReadonlyOpsView
      columns={columns}
      empty={t("No generation records in window.")}
      rows={byFailureImpact(recipes) as unknown as Record<string, unknown>[]}
      summary={recipes.length > 0 ? bucketsSummary(recipes, t) : null}
      title={t("Recipes")}
    />
  );
}

function SourcesTable({ sources }: { sources: SourceMetric[] }) {
  const { t, value } = useAdminI18n();
  const columns: OpsColumn[] = [
    { key: "sourceType", label: "Source", render: (row) => value(String(row.sourceType)) },
    { key: "total", label: "Total" },
    { key: "completed", label: "Completed" },
    {
      key: "failed",
      label: "Failed",
      render: (row) => (
        <FailedCell
          buckets={row as unknown as StatusBuckets}
          jobsQuery={failedJobsQuery({ sourceType: row.sourceType as string })}
        />
      ),
    },
    { key: "failureRate", label: "Failure rate", render: (row) => rateCell(row as unknown as StatusBuckets) },
    { key: "blocked", label: "Blocked" },
    { key: "costDreamcoins", label: "Cost" },
  ];
  return (
    <ReadonlyOpsView
      columns={columns}
      empty={t("No generation records in window.")}
      rows={byFailureImpact(sources) as unknown as Record<string, unknown>[]}
      summary={sources.length > 0 ? bucketsSummary(sources, t) : null}
      title={t("Sources")}
    />
  );
}

// SPEC: 曝光和点击各印一列却从不算 CTR —— 增长唯一要看的派生数。补上，并按 CTR 排序。
function PlacementEngagementTable({ engagement }: { engagement: PlacementEngagementMetric[] }) {
  const { t, value } = useAdminI18n();
  const totals = engagement.reduce(
    (sum, row) => ({ impressions: sum.impressions + row.impressions, clicks: sum.clicks + row.clicks }),
    { impressions: 0, clicks: 0 },
  );
  const rows = [...engagement].sort(
    (a, b) => (ratio(b.clicks, b.impressions) ?? -1) - (ratio(a.clicks, a.impressions) ?? -1),
  );
  const columns: OpsColumn[] = [
    { key: "slot", label: "Slot", render: (row) => value(String(row.slot)) },
    { key: "placementId", label: "Placement", render: (row) => <span className="font-mono">{(row.placementId as string | null) ?? "–"}</span> },
    { key: "impressions", label: "Impressions" },
    { key: "clicks", label: "Clicks" },
    {
      key: "ctr",
      label: "CTR",
      render: (row) => (
        <span className="tabular-nums">
          {formatPercent(ratio(row.clicks as number, row.impressions as number))}
        </span>
      ),
    },
  ];
  return (
    <ReadonlyOpsView
      columns={columns}
      empty={t("No generation records in window.")}
      rows={rows as unknown as Record<string, unknown>[]}
      summary={engagement.length > 0
        ? t("{impressions} impressions · {clicks} clicks · {ctr} CTR", {
            impressions: totals.impressions,
            clicks: totals.clicks,
            ctr: formatPercent(ratio(totals.clicks, totals.impressions)),
          })
        : null}
      title={t("Placement Engagement")}
    />
  );
}

function RemixSection({ total }: { total: number }): ReactNode {
  const { t } = useAdminI18n();
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h3 className="mb-3 text-sm font-semibold">{t("Remix")}</h3>
      <p className="text-xs">
        {t("Total")}: <span className="font-mono">{total}</span>
      </p>
    </section>
  );
}
