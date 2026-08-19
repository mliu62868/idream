// SPEC: the provider operations rollup — per-provider volume, outcome mix, coin cost, and
//       completion latency over an operator-chosen window.
// INTENT: migrated from the `providerOps` branch of v1 `admin/overviews/service.ts`, which
//         bundled it with the analytics and abuse overviews. Those answer different questions
//         for different permissions; only this one is queue operations, so only this one moved.
// INVARIANT: read-only, scoped to operational data classes, and bounded — latency percentiles
//            come from at most the 5000 most recent completions in the window.
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  OPERATIONAL_METRIC_DATA_SCOPE,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LATENCY_SAMPLE_LIMIT = 5_000;

export async function getProviderOperations(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const query = queryParams(request, "GET /api/v2/admin/ops/providers");
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(now.getTime() - DEFAULT_WINDOW_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest("Invalid provider window");
  }
  const createdAt = { gte: from, lte: to };

  const [grouped, completedJobs] = await Promise.all([
    prisma.generationJob.groupBy({
      by: ["provider", "status"],
      where: operationalGenerationJobWhere({ createdAt }),
      _count: { _all: true },
      _sum: { costDreamcoins: true },
    }),
    prisma.generationJob.findMany({
      where: operationalGenerationJobWhere({
        createdAt,
        status: "completed",
        completedAt: { not: null },
      }),
      select: { provider: true, createdAt: true, completedAt: true },
      orderBy: { createdAt: "desc" },
      take: LATENCY_SAMPLE_LIMIT,
    }),
  ]);

  const stats = new Map<
    string,
    { total: number; completed: number; failed: number; blocked: number; coinsCost: number }
  >();
  for (const row of grouped) {
    const provider = row.provider ?? "unknown";
    const value = stats.get(provider) ??
      { total: 0, completed: 0, failed: 0, blocked: 0, coinsCost: 0 };
    value.total += row._count._all;
    value.coinsCost += row._sum.costDreamcoins ?? 0;
    if (row.status === "completed") value.completed += row._count._all;
    if (row.status === "failed") value.failed += row._count._all;
    if (row.status === "blocked") value.blocked += row._count._all;
    stats.set(provider, value);
  }

  const latencies = new Map<string, number[]>();
  for (const job of completedJobs) {
    if (!job.completedAt) continue;
    const ms = job.completedAt.getTime() - job.createdAt.getTime();
    if (ms < 0) continue;
    const provider = job.provider ?? "unknown";
    latencies.set(provider, [...(latencies.get(provider) ?? []), ms]);
  }

  return {
    dataScope: OPERATIONAL_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    providers: [...stats.entries()]
      .map(([provider, value]) => {
        const finished = value.completed + value.failed + value.blocked;
        const sorted = (latencies.get(provider) ?? []).sort((a, b) => a - b);
        return {
          provider,
          ...value,
          successRate: finished > 0 ? Math.round((value.completed / finished) * 100) : null,
          avgCostPerJob: value.total > 0
            ? Math.round((value.coinsCost / value.total) * 10) / 10
            : 0,
          latencyP50Ms: percentile(sorted, 50),
          latencyP95Ms: percentile(sorted, 95),
          latencySamples: sorted.length,
        };
      })
      .sort((a, b) => b.total - a.total),
  };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}
