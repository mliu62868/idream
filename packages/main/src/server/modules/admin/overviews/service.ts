import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/shared/legacy-primitives";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  OPERATIONAL_METRIC_DATA_SCOPE,
  customerAnalyticsEventWhere,
  customerDreamcoinLedgerWhere,
  customerGenerationJobWhere,
  customerSubscriptionWhere,
  customerUserWhere,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";

export async function analyticsOverview(request: Request) {
  await actorWithPermission(request, "analytics.export");
  const { from, to, createdAt } = windowFromRequest(request, "analytics");
  const [
    signups,
    activatedRows,
    payingRows,
    generationByStatus,
    grantedAgg,
    spentAgg,
    ledgerByReason,
    eventRows,
  ] = await Promise.all([
    prisma.user.count({
      where: customerUserWhere({ createdAt, deletedAt: null }),
    }),
    prisma.generationJob.groupBy({
      by: ["userId"],
      where: customerGenerationJobWhere({ createdAt }),
    }),
    prisma.subscription.groupBy({
      by: ["userId"],
      where: customerSubscriptionWhere({ createdAt }),
    }),
    prisma.generationJob.groupBy({
      by: ["status"],
      where: customerGenerationJobWhere({ createdAt }),
      _count: { _all: true },
    }),
    prisma.dreamcoinLedger.aggregate({
      where: customerDreamcoinLedgerWhere({
        createdAt,
        delta: { gt: 0 },
      }),
      _sum: { delta: true },
    }),
    prisma.dreamcoinLedger.aggregate({
      where: customerDreamcoinLedgerWhere({
        createdAt,
        delta: { lt: 0 },
      }),
      _sum: { delta: true },
    }),
    prisma.dreamcoinLedger.groupBy({
      by: ["reason"],
      where: customerDreamcoinLedgerWhere({ createdAt }),
      _sum: { delta: true },
      _count: { _all: true },
    }),
    prisma.analyticsEvent.groupBy({
      by: ["name"],
      where: customerAnalyticsEventWhere({ createdAt }),
      _count: { _all: true },
    }),
  ]);
  const activatedUsers = activatedRows.length;
  const payingUsers = payingRows.length;
  const conversionRate =
    signups > 0 ? Math.round((payingUsers / signups) * 100) : 0;
  const statusCount = (status: string) =>
    generationByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const total = generationByStatus.reduce(
    (sum, row) => sum + row._count._all,
    0,
  );
  const coinsGranted = grantedAgg._sum.delta ?? 0;
  const coinsSpent = spentAgg._sum.delta ?? 0;
  return ok({
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    funnel: {
      signups,
      activatedUsers: null,
      payingUsers: null,
      conversionRate: null,
      qualityState: "invalid",
      validForDecisions: false,
      metricVersion: "legacy-v1",
      reason:
        "Legacy activation used any generation job and conversion mixed unrelated windows; certified cohort metrics are not available yet.",
      legacyObserved: { activatedUsers, payingUsers, conversionRate },
    },
    generation: {
      total,
      completed: statusCount("completed"),
      failed: statusCount("failed"),
      blocked: statusCount("blocked"),
      qualityState: "directional",
      validForDecisions: false,
      reason:
        "Legacy status counts are operational diagnostics, not fulfillment outcomes.",
    },
    economy: {
      coinsGranted,
      coinsSpent,
      net: coinsGranted + coinsSpent,
      byReason: ledgerByReason
        .map((row) => ({
          reason: row.reason,
          totalDelta: row._sum.delta ?? 0,
          count: row._count._all,
        }))
        .sort((a, b) => a.reason.localeCompare(b.reason)),
    },
    topEvents: eventRows
      .map((row) => ({ name: row.name, count: row._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  });
}

export async function providerOps(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const { from, to, createdAt } = windowFromRequest(request, "provider");
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
      take: 5000,
    }),
  ]);
  const stats = new Map<
    string,
    {
      total: number;
      completed: number;
      failed: number;
      blocked: number;
      coinsCost: number;
    }
  >();
  for (const row of grouped) {
    const provider = row.provider ?? "unknown";
    const value = stats.get(provider) ?? {
      total: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      coinsCost: 0,
    };
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
  const providers = [...stats.entries()]
    .map(([provider, value]) => {
      const finished = value.completed + value.failed + value.blocked;
      const sorted = (latencies.get(provider) ?? []).sort((a, b) => a - b);
      return {
        provider,
        ...value,
        successRate:
          finished > 0
            ? Math.round((value.completed / finished) * 100)
            : null,
        avgCostPerJob:
          value.total > 0
            ? Math.round((value.coinsCost / value.total) * 10) / 10
            : 0,
        latencyP50Ms: percentile(sorted, 50),
        latencyP95Ms: percentile(sorted, 95),
        latencySamples: sorted.length,
      };
    })
    .sort((a, b) => b.total - a.total);
  return ok({
    dataScope: OPERATIONAL_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    providers,
  });
}

function windowFromRequest(request: Request, label: string) {
  const url = new URL(request.url);
  const now = new Date();
  const to = url.searchParams.get("to")
    ? new Date(url.searchParams.get("to") as string)
    : now;
  const from = url.searchParams.get("from")
    ? new Date(url.searchParams.get("from") as string)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest(`Invalid ${label} window`);
  }
  return { from, to, createdAt: { gte: from, lte: to } };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}
