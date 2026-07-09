// SPEC: 生成 Metric 回路（spec §2.1 Metric）：按 profile/recipe/source/placement 聚合
//       近 N 天 GenerationJob 表现（量/成败/成本/平均时长）与投放位状态分布。
// INTENT: 零 DDL——当前规模按需聚合足够；物化 rollup 表留给将来性能需要。
// INVARIANTS: 只读；generation.config.read 门；days ∈ [1,90] 默认 7。
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import { actorWithPermission, clampInt } from "@/server/modules/admin/service";

const CONFIG_READ = "generation.config.read" as const;

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

export async function generationMetrics(request: Request): Promise<Response> {
  await actorWithPermission(request, CONFIG_READ);
  const url = new URL(request.url);
  const windowDays = clampInt(url.searchParams.get("days"), 1, 90, 7);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [
    byProfileRaw,
    byRecipeRaw,
    bySource,
    placementRows,
    durations,
    placementEngagementRaw,
    remixRows,
  ] = await Promise.all([
    prisma.generationJob.groupBy({
      by: ["profileId", "profileVersion", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.groupBy({
      by: ["recipeId", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.groupBy({
      by: ["sourceType", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.mediaAssetPlacement.groupBy({
      by: ["slot", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ profileId: string; avgMs: number | null }>>`
      SELECT "profileId", GREATEST(0, AVG(EXTRACT(EPOCH FROM ("completedAt" - "createdAt")) * 1000))::float8 AS "avgMs"
      FROM "generation_jobs"
      WHERE "createdAt" >= ${since} AND "completedAt" IS NOT NULL AND "profileId" IS NOT NULL
      GROUP BY "profileId"
    `,
    prisma.$queryRaw<
      Array<{ slot: string; placementId: string | null; impressions: number; clicks: number }>
    >`
      SELECT props->>'slot' AS slot, props->>'placementId' AS "placementId",
             count(*) FILTER (WHERE name='placement_impression')::int AS impressions,
             count(*) FILTER (WHERE name='placement_click')::int AS clicks
      FROM "analytics_events"
      WHERE name IN ('placement_impression','placement_click') AND "createdAt" >= ${since}
      GROUP BY 1,2
    `,
    prisma.analyticsEvent.count({ where: { name: "feed_item_remixed", createdAt: { gte: since } } }),
  ]);
  const byProfile = byProfileRaw.filter(
    (row): row is typeof row & { profileId: string } => row.profileId !== null,
  );
  const byRecipe = byRecipeRaw.filter(
    (row): row is typeof row & { recipeId: string } => row.recipeId !== null,
  );

  const avgByProfile = new Map(durations.map((row) => [row.profileId, row.avgMs]));

  const profileMap = new Map<
    string,
    StatusBuckets & { profileId: string; profileVersion: number | null; costDreamcoins: number }
  >();
  for (const row of byProfile) {
    const profileId = row.profileId;
    const key = `${profileId}@${row.profileVersion ?? 0}`;
    const entry =
      profileMap.get(key) ??
      { ...emptyBuckets(), profileId, profileVersion: row.profileVersion, costDreamcoins: 0 };
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
      profileMeta.set(record.profileKey, {
        label: record.label,
        workflowKey: record.workflowKey,
      });
    }
  }

  const recipeMap = new Map<string, StatusBuckets & { recipeId: string; costDreamcoins: number }>();
  for (const row of byRecipe) {
    const recipeId = row.recipeId;
    const entry =
      recipeMap.get(recipeId) ?? { ...emptyBuckets(), recipeId, costDreamcoins: 0 };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    recipeMap.set(recipeId, entry);
  }

  const sourceMap = new Map<string, StatusBuckets & { sourceType: string; costDreamcoins: number }>();
  for (const row of bySource) {
    const entry =
      sourceMap.get(row.sourceType) ??
      { ...emptyBuckets(), sourceType: row.sourceType, costDreamcoins: 0 };
    bucketFor(row.status, entry, row._count._all);
    entry.costDreamcoins += row._sum.costDreamcoins ?? 0;
    sourceMap.set(row.sourceType, entry);
  }

  return ok({
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
    placementEngagement: placementEngagementRaw,
    remix: { total: remixRows },
  });
}
