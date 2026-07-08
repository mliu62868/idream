"use client";

// SPEC: 只读展示 generation metrics（profiles/recipes/sources/placements）聚合视图 ——
//       7/30 天窗口切换，四个 section 表格；失败率>20% 高亮。
// INTENT: selfFetch 模式镜像 BackendsView.tsx；纯展示，无写操作。
// INVARIANTS: avgDurationMs 渲染为 "x.x s"（null → "–"）；failed/total>0.2 时该行 failed 单元格标红。

import { useEffect, useState, type ReactNode } from "react";
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

type MetricsResponse = {
  windowDays: number;
  profiles: ProfileMetric[];
  recipes: RecipeMetric[];
  sources: SourceMetric[];
  placements: PlacementMetric[];
};

const WINDOW_OPTIONS = [7, 30] as const;

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
  const [windowDays, setWindowDays] = useState<(typeof WINDOW_OPTIONS)[number]>(7);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(days: number) {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<MetricsResponse>(`/api/v1/admin/generation/metrics?days=${days}`);
      setMetrics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(windowDays);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [windowDays]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t("Metrics")}</h2>
        <div className="flex items-center gap-2">
          <div className="flex border border-white/10">
            {WINDOW_OPTIONS.map((days) => (
              <button
                className={cn(
                  "h-9 px-3 text-sm",
                  windowDays === days ? "bg-white/10" : "opacity-70 hover:opacity-100",
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
            className="inline-flex h-9 items-center gap-2 border border-white/10 px-3 text-sm disabled:opacity-50"
            disabled={loading}
            onClick={() => void load(windowDays)}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            {t("Refresh")}
          </button>
        </div>
      </div>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}

      <ProfilesTable profiles={metrics?.profiles ?? []} t={t} />
      <RecipesTable recipes={metrics?.recipes ?? []} t={t} />
      <SourcesTable sources={metrics?.sources ?? []} t={t} />
      <PlacementsTable placements={metrics?.placements ?? []} t={t} />
    </div>
  );
}

type Translate = (text: string) => string;

function SectionShell({ title, isEmpty, t, children }: { title: string; isEmpty: boolean; t: Translate; children: ReactNode }) {
  return (
    <section className="border border-white/10 bg-[rgb(18,18,18)] p-4">
      <h3 className="mb-3 text-sm font-semibold">{t(title)}</h3>
      {isEmpty ? (
        <p className="text-xs text-[rgb(170,170,170)]">{t("No generation records in window.")}</p>
      ) : (
        children
      )}
    </section>
  );
}

function ProfilesTable({ profiles, t }: { profiles: ProfileMetric[]; t: Translate }) {
  return (
    <SectionShell isEmpty={profiles.length === 0} t={t} title="Profiles">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[rgb(170,170,170)]">
              <th className="pb-2 pr-4">{t("Label")}</th>
              <th className="pb-2 pr-4">{t("Profile")}</th>
              <th className="pb-2 pr-4">{t("Workflow")}</th>
              <th className="pb-2 pr-4">{t("Total")}</th>
              <th className="pb-2 pr-4">{t("Completed")}</th>
              <th className="pb-2 pr-4">{t("Failed")}</th>
              <th className="pb-2 pr-4">{t("Blocked")}</th>
              <th className="pb-2 pr-4">{t("Cost")}</th>
              <th className="pb-2">{t("Avg Duration")}</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((row) => {
              const isHighFailure = failureRate(row) > 0.2;
              return (
                <tr className="border-t border-white/5" key={`${row.profileId}@${row.profileVersion ?? 0}`}>
                  <td className="py-2 pr-4">{row.label ?? "–"}</td>
                  <td className="py-2 pr-4 font-mono">
                    {row.profileId}@{row.profileVersion ?? 0}
                  </td>
                  <td className="py-2 pr-4 font-mono">{row.workflowKey ?? "–"}</td>
                  <td className="py-2 pr-4">{row.total}</td>
                  <td className="py-2 pr-4">{row.completed}</td>
                  <td className={cn("py-2 pr-4", isHighFailure && "text-red-300")}>{row.failed}</td>
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
    <SectionShell isEmpty={recipes.length === 0} t={t} title="Recipes">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[rgb(170,170,170)]">
              <th className="pb-2 pr-4">{t("Recipe")}</th>
              <th className="pb-2 pr-4">{t("Total")}</th>
              <th className="pb-2 pr-4">{t("Completed")}</th>
              <th className="pb-2 pr-4">{t("Failed")}</th>
              <th className="pb-2 pr-4">{t("Blocked")}</th>
              <th className="pb-2">{t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {recipes.map((row) => {
              const isHighFailure = failureRate(row) > 0.2;
              return (
                <tr className="border-t border-white/5" key={row.recipeId}>
                  <td className="py-2 pr-4 font-mono">{row.recipeId}</td>
                  <td className="py-2 pr-4">{row.total}</td>
                  <td className="py-2 pr-4">{row.completed}</td>
                  <td className={cn("py-2 pr-4", isHighFailure && "text-red-300")}>{row.failed}</td>
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
    <SectionShell isEmpty={sources.length === 0} t={t} title="Sources">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[rgb(170,170,170)]">
              <th className="pb-2 pr-4">{t("Source")}</th>
              <th className="pb-2 pr-4">{t("Total")}</th>
              <th className="pb-2 pr-4">{t("Completed")}</th>
              <th className="pb-2 pr-4">{t("Failed")}</th>
              <th className="pb-2 pr-4">{t("Blocked")}</th>
              <th className="pb-2">{t("Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((row) => {
              const isHighFailure = failureRate(row) > 0.2;
              return (
                <tr className="border-t border-white/5" key={row.sourceType}>
                  <td className="py-2 pr-4 font-mono">{row.sourceType}</td>
                  <td className="py-2 pr-4">{row.total}</td>
                  <td className="py-2 pr-4">{row.completed}</td>
                  <td className={cn("py-2 pr-4", isHighFailure && "text-red-300")}>{row.failed}</td>
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
    <SectionShell isEmpty={placements.length === 0} t={t} title="Placements">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[rgb(170,170,170)]">
              <th className="pb-2 pr-4">{t("Slot")}</th>
              <th className="pb-2 pr-4">{t("Status")}</th>
              <th className="pb-2">{t("Count")}</th>
            </tr>
          </thead>
          <tbody>
            {placements.map((row) => (
              <tr className="border-t border-white/5" key={`${row.slot}:${row.status}`}>
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
