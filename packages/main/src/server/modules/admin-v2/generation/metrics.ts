// SPEC: the generation Metric rollup — recent GenerationJob volume, outcome, cost, and duration
//       aggregated by profile / recipe / source, plus placement status and engagement.
// INTENT: migrated from v1 `generation-metrics.ts`. Still aggregated on demand with zero DDL:
//         at this volume the group-bys are cheap, and a materialized rollup is a cost to pay
//         when a query actually becomes slow, not before.
// INVARIANT: read-only, and scoped to operational data classes on every source table.
import { prisma } from "@/server/lib/db";
import {
  OPERATIONAL_METRIC_DATA_SCOPE,
  OPERATIONAL_EVENT_DATA_CLASS_SQL,
  OPERATIONAL_USER_DATA_CLASS_SQL,
  operationalAnalyticsEventWhere,
  operationalGenerationJobWhere,
  operationalMediaAssetPlacementWhere,
} from "@/server/modules/metric-data-scope";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";

type StatusBuckets = { total: number; completed: number; failed: number; blocked: number };

function emptyBuckets(): StatusBuckets {
  return { total: 0, completed: 0, failed: 0, blocked: 0 };
}

function bucketFor(status: string, buckets: StatusBuckets, count: number) {
  buckets.total += count;
  if (status === "completed") buckets.completed += count;
  else if (status === "failed") buckets.failed += count;
  else if (status === "blocked") buckets.blocked += count;
}

export async function getGenerationMetrics(request: Request) {
  await actorWithPermission(request, "generation.config.read");
  const query = queryParams(request, "GET /api/v2/admin/generation/metrics");
  const windowDays = query.days ?? 7;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const now = new Date();
  const since = new Date(now.getTime() - windowMs);
  // 紧邻的等长上一周期，用来回答「失败率在上升吗」。半开区间，两期不重叠也不留缝。
  const previousSince = new Date(since.getTime() - windowMs);
  const previousRange = { gte: previousSince, lt: since };

  const [
    byProfileRaw,
    byRecipeRaw,
    bySource,
    placementRows,
    durations,
    placementEngagement,
    remixTotal,
    previousByStatus,
    previousEngagement,
    previousRemixTotal,
  ] = await Promise.all([
    prisma.generationJob.groupBy({
      by: ["profileId", "profileVersion", "status"],
      where: operationalGenerationJobWhere({ createdAt: { gte: since } }),
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.groupBy({
      by: ["recipeId", "status"],
      where: operationalGenerationJobWhere({ createdAt: { gte: since } }),
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.groupBy({
      by: ["sourceType", "status"],
      where: operationalGenerationJobWhere({ createdAt: { gte: since } }),
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.mediaAssetPlacement.groupBy({
      by: ["slot", "status"],
      where: operationalMediaAssetPlacementWhere({ createdAt: { gte: since } }),
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ profileId: string; avgMs: number | null }>>`
      SELECT jobs."profileId",
             GREATEST(0, AVG(EXTRACT(EPOCH FROM (jobs."completedAt" - jobs."createdAt")) * 1000))::float8 AS "avgMs"
      FROM "generation_jobs" jobs
      JOIN "users" owners ON owners.id = jobs."userId"
      WHERE jobs."createdAt" >= ${since}
        AND jobs."completedAt" IS NOT NULL
        AND jobs."profileId" IS NOT NULL
        AND owners."dataClass" IN (${OPERATIONAL_USER_DATA_CLASS_SQL})
      GROUP BY jobs."profileId"
    `,
    prisma.$queryRaw<
      Array<{ slot: string | null; placementId: string | null; impressions: number; clicks: number }>
    >`
      SELECT props->>'slot' AS slot, props->>'placementId' AS "placementId",
             count(*) FILTER (WHERE name='placement_impression')::int AS impressions,
             count(*) FILTER (WHERE name='placement_click')::int AS clicks
      FROM "analytics_events"
      WHERE name IN ('placement_impression','placement_click')
        AND "createdAt" >= ${since}
        AND "dataClass" IN (${OPERATIONAL_EVENT_DATA_CLASS_SQL})
      GROUP BY 1,2
    `,
    prisma.analyticsEvent.count({
      where: operationalAnalyticsEventWhere({
        name: "feed_item_remixed",
        createdAt: { gte: since },
      }),
    }),
    prisma.generationJob.groupBy({
      by: ["status"],
      where: operationalGenerationJobWhere({ createdAt: previousRange }),
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.$queryRaw<Array<{ impressions: number; clicks: number }>>`
      SELECT count(*) FILTER (WHERE name='placement_impression')::int AS impressions,
             count(*) FILTER (WHERE name='placement_click')::int AS clicks
      FROM "analytics_events"
      WHERE name IN ('placement_impression','placement_click')
        AND "createdAt" >= ${previousSince}
        AND "createdAt" < ${since}
        AND "dataClass" IN (${OPERATIONAL_EVENT_DATA_CLASS_SQL})
    `,
    prisma.analyticsEvent.count({
      where: operationalAnalyticsEventWhere({
        name: "feed_item_remixed",
        createdAt: previousRange,
      }),
    }),
  ]);

  const avgByProfile = new Map(durations.map((row) => [row.profileId, row.avgMs]));

  const profileMap = new Map<
    string,
    StatusBuckets & { profileId: string; profileVersion: number | null; costDreamcoins: number }
  >();
  for (const row of byProfileRaw) {
    if (row.profileId === null) continue;
    const key = `${row.profileId}@${row.profileVersion ?? 0}`;
    const entry = profileMap.get(key) ?? {
      ...emptyBuckets(),
      profileId: row.profileId,
      profileVersion: row.profileVersion,
      costDreamcoins: 0,
    };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    profileMap.set(key, entry);
  }

  const profileKeys = [...new Set([...profileMap.values()].map((entry) => entry.profileId))];
  const profileRecords = await prisma.generationModelProfile.findMany({
    where: { profileKey: { in: profileKeys } },
    orderBy: { version: "desc" },
    select: { profileKey: true, label: true, workflowKey: true },
  });
  const profileMeta = new Map<string, { label: string; workflowKey: string | null }>();
  for (const record of profileRecords) {
    if (!profileMeta.has(record.profileKey)) {
      profileMeta.set(record.profileKey, { label: record.label, workflowKey: record.workflowKey });
    }
  }

  const recipeMap = new Map<string, StatusBuckets & { recipeId: string; costDreamcoins: number }>();
  for (const row of byRecipeRaw) {
    if (row.recipeId === null) continue;
    const entry = recipeMap.get(row.recipeId) ??
      { ...emptyBuckets(), recipeId: row.recipeId, costDreamcoins: 0 };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    recipeMap.set(row.recipeId, entry);
  }

  const sourceMap = new Map<string, StatusBuckets & { sourceType: string; costDreamcoins: number }>();
  for (const row of bySource) {
    const entry = sourceMap.get(row.sourceType) ??
      { ...emptyBuckets(), sourceType: row.sourceType, costDreamcoins: 0 };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    sourceMap.set(row.sourceType, entry);
  }

  // 本期总量按 sourceType 汇总而不是把 profiles[] 加起来：sourceType 非空，profileId /
  // recipeId 可空且逐行数据里被跳过，用它们求和会把本期算小，变化方向就反了。
  const currentTotals = emptyBuckets();
  let currentCost = 0;
  for (const entry of sourceMap.values()) {
    currentTotals.total += entry.total;
    currentTotals.completed += entry.completed;
    currentTotals.failed += entry.failed;
    currentTotals.blocked += entry.blocked;
    currentCost += entry.costDreamcoins;
  }
  const previousTotals = emptyBuckets();
  let previousCost = 0;
  for (const row of previousByStatus) {
    bucketFor(row.status, previousTotals, row._count._all);
    previousCost += row._sum.costDreamcoins ?? 0;
  }

  return {
    dataScope: OPERATIONAL_METRIC_DATA_SCOPE,
    windowDays,
    profiles: [...profileMap.values()]
      .map((entry) => ({
        ...entry,
        label: profileMeta.get(entry.profileId)?.label ?? null,
        workflowKey: profileMeta.get(entry.profileId)?.workflowKey ?? null,
        avgDurationMs: avgByProfile.get(entry.profileId) ?? null,
      }))
      .sort((a, b) => b.total - a.total),
    recipes: [...recipeMap.values()].sort((a, b) => b.total - a.total),
    sources: [...sourceMap.values()].sort((a, b) => b.total - a.total),
    placements: placementRows.map((row) => ({
      slot: row.slot,
      status: row.status,
      count: row._count._all,
    })),
    placementEngagement,
    remix: { total: remixTotal },
    periods: {
      current: {
        from: since.toISOString(),
        to: now.toISOString(),
        ...currentTotals,
        costDreamcoins: currentCost,
        impressions: placementEngagement.reduce((sum, row) => sum + row.impressions, 0),
        clicks: placementEngagement.reduce((sum, row) => sum + row.clicks, 0),
        remixTotal,
      },
      previous: {
        from: previousSince.toISOString(),
        to: since.toISOString(),
        ...previousTotals,
        costDreamcoins: previousCost,
        impressions: previousEngagement[0]?.impressions ?? 0,
        clicks: previousEngagement[0]?.clicks ?? 0,
        remixTotal: previousRemixTotal,
      },
    },
  };
}
