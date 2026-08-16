"use client";

// SPEC: 只读展示 generation metrics（profiles/recipes/sources/placements）聚合视图 ——
//       7/30 天窗口切换，四个 section 表格；失败率>20% 高亮。
// INTENT: selfFetch 模式镜像 BackendsView.tsx；纯展示，无写操作。
// INVARIANTS: avgDurationMs 渲染为 "x.x s"（null → "–"）；failed/total>0.2 时该行 failed 单元格标红。

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
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

export function metricsSnapshotForWindow(
  snapshots: MetricsSnapshots,
  windowDays: MetricsWindowDays,
) {
  return snapshots[windowDays] ?? null;
}

export function metricsWindowErrorMessage(input: {
  error: string;
  requestedWindowDays: MetricsWindowDays;
  hasRequestedSnapshot: boolean;
  lastGoodWindowDays: MetricsWindowDays | null;
}) {
  if (input.hasRequestedSnapshot) {
    return `${input.error} Showing the last successfully loaded ${input.requestedWindowDays}-day snapshot.`;
  }
  if (
    input.lastGoodWindowDays !== null &&
    input.lastGoodWindowDays !== input.requestedWindowDays
  ) {
    return `${input.error} ${input.requestedWindowDays}-day metrics are unavailable. The last successful snapshot was ${input.lastGoodWindowDays} days and is not shown for this window.`;
  }
  return `${input.error} ${input.requestedWindowDays}-day metrics are unavailable.`;
}

function failureRate(buckets: StatusBuckets): number {
  if (buckets.total === 0) return 0;
  return buckets.failed / buckets.total;
}

function formatDuration(avgDurationMs: number | null): string {
  if (avgDurationMs === null) return "–";
  return `${(avgDurationMs / 1000).toFixed(1)} s`;
}

export function GenerationMetricsView() {
  const { t } = useAdminI18n();
  const [windowDays, setWindowDays] = useState<MetricsWindowDays>(7);
  const [snapshots, setSnapshots] = useState<MetricsSnapshots>({});
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
          `Metrics authority returned ${data.windowDays} days for a ${days}-day request.`,
        );
      }
      setSnapshots((current) => ({ ...current, [days]: data }));
      setLastGoodWindowDays(days);
    } catch (err) {
      setErrorsByWindow((current) => ({
        ...current,
        [days]: err instanceof Error ? err.message : "Load failed",
      }));
    } finally {
      setLoadingByWindow((current) => ({ ...current, [days]: false }));
    }
  }, []);

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
          {errorMessage}
        </p>
      ) : null}

      {metrics ? (
        <>
          <ProfilesTable profiles={metrics.profiles} t={t} />
          <RecipesTable recipes={metrics.recipes} t={t} />
          <SourcesTable sources={metrics.sources} t={t} />
          <PlacementsTable placements={metrics.placements} t={t} />
          <PlacementEngagementTable engagement={metrics.placementEngagement} t={t} />
          <RemixSection total={metrics.remix.total} t={t} />
        </>
      ) : (
        <MetricsAuthorityState loading={loading} t={t} />
      )}
    </div>
  );
}

type Translate = (text: string) => string;

function MetricsAuthorityState({ loading, t }: { loading: boolean; t: Translate }) {
  return (
    <section
      aria-live="polite"
      className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 text-sm text-[var(--ad-text-muted)]"
      role="status"
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("Loading authoritative generation metrics...")}
        </span>
      ) : (
        t("Generation metrics are unavailable. No values are shown until the authority request succeeds.")
      )}
    </section>
  );
}

function SectionShell({ title, isEmpty, t, children }: { title: string; isEmpty: boolean; t: Translate; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h3 className="mb-3 text-sm font-semibold">{t(title)}</h3>
      {isEmpty ? (
        <p className="text-xs text-[var(--ad-text-muted)]">{t("No generation records in window.")}</p>
      ) : (
        children
      )}
    </section>
  );
}

function ProfilesTable({ profiles, t }: { profiles: ProfileMetric[]; t: Translate }) {
  return (
    <SectionShell isEmpty={profiles.length === 0} t={t} title={t("Profiles")}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t("Generation profiles")}</caption>
          <thead>
            <tr className="text-[var(--ad-text-muted)]">
              <th scope="col" className="pb-2 pr-4">{t("Label")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Profile")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Workflow")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Total")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Completed")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Failed")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Blocked")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Cost")}</th>
              <th scope="col" className="pb-2">{t("Avg Duration")}</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((row) => {
              const isHighFailure = failureRate(row) > 0.2;
              return (
                <tr className="border-t border-[var(--ad-border)]" key={`${row.profileId}@${row.profileVersion ?? 0}`}>
                  <td className="py-2 pr-4">{row.label ?? "–"}</td>
                  <td className="py-2 pr-4 font-mono">
                    {row.profileId}@{row.profileVersion ?? 0}
                  </td>
                  <td className="py-2 pr-4 font-mono">{row.workflowKey ?? "–"}</td>
                  <td className="py-2 pr-4">{row.total}</td>
                  <td className="py-2 pr-4">{row.completed}</td>
                  <td className={cn("py-2 pr-4", isHighFailure && "text-[var(--ad-red-text)]")}>{row.failed}</td>
                  <td className="py-2 pr-4">{row.blocked}</td>
                  <td className="py-2 pr-4">{row.costDreamcoins}</td>
                  <td className="py-2">{formatDuration(row.avgDurationMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function RecipesTable({ recipes, t }: { recipes: RecipeMetric[]; t: Translate }) {
  return (
    <SectionShell isEmpty={recipes.length === 0} t={t} title={t("Recipes")}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t("Generation recipes")}</caption>
          <thead>
            <tr className="text-[var(--ad-text-muted)]">
              <th scope="col" className="pb-2 pr-4">{t("Recipe")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Total")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Completed")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Failed")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Blocked")}</th>
              <th scope="col" className="pb-2">{t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {recipes.map((row) => {
              const isHighFailure = failureRate(row) > 0.2;
              return (
                <tr className="border-t border-[var(--ad-border)]" key={row.recipeId}>
                  <td className="py-2 pr-4 font-mono">{row.recipeId}</td>
                  <td className="py-2 pr-4">{row.total}</td>
                  <td className="py-2 pr-4">{row.completed}</td>
                  <td className={cn("py-2 pr-4", isHighFailure && "text-[var(--ad-red-text)]")}>{row.failed}</td>
                  <td className="py-2 pr-4">{row.blocked}</td>
                  <td className="py-2">{row.costDreamcoins}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function SourcesTable({ sources, t }: { sources: SourceMetric[]; t: Translate }) {
  return (
    <SectionShell isEmpty={sources.length === 0} t={t} title={t("Sources")}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t("Generation sources")}</caption>
          <thead>
            <tr className="text-[var(--ad-text-muted)]">
              <th scope="col" className="pb-2 pr-4">{t("Source")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Total")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Completed")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Failed")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Blocked")}</th>
              <th scope="col" className="pb-2">{t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((row) => {
              const isHighFailure = failureRate(row) > 0.2;
              return (
                <tr className="border-t border-[var(--ad-border)]" key={row.sourceType}>
                  <td className="py-2 pr-4 font-mono">{row.sourceType}</td>
                  <td className="py-2 pr-4">{row.total}</td>
                  <td className="py-2 pr-4">{row.completed}</td>
                  <td className={cn("py-2 pr-4", isHighFailure && "text-[var(--ad-red-text)]")}>{row.failed}</td>
                  <td className="py-2 pr-4">{row.blocked}</td>
                  <td className="py-2">{row.costDreamcoins}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function PlacementsTable({ placements, t }: { placements: PlacementMetric[]; t: Translate }) {
  return (
    <SectionShell isEmpty={placements.length === 0} t={t} title={t("Placements")}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t("Generation placements")}</caption>
          <thead>
            <tr className="text-[var(--ad-text-muted)]">
              <th scope="col" className="pb-2 pr-4">{t("Slot")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Status")}</th>
              <th scope="col" className="pb-2">{t("Count")}</th>
            </tr>
          </thead>
          <tbody>
            {placements.map((row) => (
              <tr className="border-t border-[var(--ad-border)]" key={`${row.slot}:${row.status}`}>
                <td className="py-2 pr-4 font-mono">{row.slot}</td>
                <td className="py-2 pr-4">{row.status}</td>
                <td className="py-2">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function PlacementEngagementTable({
  engagement,
  t,
}: {
  engagement: PlacementEngagementMetric[];
  t: Translate;
}) {
  return (
    <SectionShell isEmpty={engagement.length === 0} t={t} title={t("Placement Engagement")}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t("Placement engagement")}</caption>
          <thead>
            <tr className="text-[var(--ad-text-muted)]">
              <th scope="col" className="pb-2 pr-4">{t("Slot")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Placement")}</th>
              <th scope="col" className="pb-2 pr-4">{t("Impressions")}</th>
              <th scope="col" className="pb-2">{t("Clicks")}</th>
            </tr>
          </thead>
          <tbody>
            {engagement.map((row) => (
              <tr className="border-t border-[var(--ad-border)]" key={`${row.slot}:${row.placementId}`}>
                <td className="py-2 pr-4 font-mono">{row.slot}</td>
                <td className="py-2 pr-4 font-mono">{row.placementId ?? "–"}</td>
                <td className="py-2 pr-4">{row.impressions}</td>
                <td className="py-2">{row.clicks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function RemixSection({ total, t }: { total: number; t: Translate }) {
  return (
    <section className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4">
      <h3 className="mb-3 text-sm font-semibold">{t("Remix")}</h3>
      <p className="text-xs">
        {t("Total")}: <span className="font-mono">{total}</span>
      </p>
    </section>
  );
}
