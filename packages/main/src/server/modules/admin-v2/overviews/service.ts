// SPEC: 后台四张只读运营大盘 —— dashboard、analytics overview、risk/abuse、ops/providers。
// INTENT: 三张窗口型大盘共用同一个 from/to 查询契约，但各自声明自己的响应契约；
//         legacy 口径（activation / conversion）保留 `qualityState:"invalid"` 的诚实标注，
//         而不是把没认证的数字直接当结论发出去。
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  OPERATIONAL_METRIC_DATA_SCOPE,
  customerAnalyticsEventWhere,
  customerContentReportWhere,
  customerDreamcoinLedgerWhere,
  customerGenerationJobWhere,
  customerReferralWhere,
  customerSubscriptionWhere,
  customerUserWhere,
  operationalGenerationJobWhere,
} from "@/server/modules/metric-data-scope";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";

type WindowQuery = { readonly from?: string; readonly to?: string };

function resolveWindow(query: WindowQuery, label: string) {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest(`Invalid ${label} window`);
  }
  return { from, to, createdAt: { gte: from, lte: to } };
}

function featureFlagDto(flag: {
  key: string;
  label: string;
  enabled: boolean;
  rolloutPercent: number;
  hardPolicy: boolean;
}) {
  return {
    key: flag.key,
    label: flag.label,
    enabled: flag.enabled,
    rolloutPercent: flag.rolloutPercent,
    hardPolicy: flag.hardPolicy,
  };
}

export async function adminDashboard(request: Request) {
  await actorWithPermission(request, "dashboard.read");
  const [
    activeUsers,
    suspendedUsers,
    queuedJobs,
    failedJobs,
    completedJobs,
    blockedJobs,
    openReports,
    activeSubscriptions,
    flags,
  ] = await Promise.all([
    prisma.user.count({
      where: customerUserWhere({ status: "active", deletedAt: null }),
    }),
    prisma.user.count({ where: customerUserWhere({ status: "suspended" }) }),
    prisma.generationJob.count({
      where: customerGenerationJobWhere({
        status: { in: ["queued", "moderating_input", "running", "moderating_output"] },
      }),
    }),
    prisma.generationJob.count({
      where: customerGenerationJobWhere({ status: "failed" }),
    }),
    prisma.generationJob.count({
      where: customerGenerationJobWhere({ status: "completed" }),
    }),
    prisma.generationJob.count({
      where: customerGenerationJobWhere({ status: "blocked" }),
    }),
    prisma.contentReport.count({
      where: customerContentReportWhere({
        status: { in: ["open", "triaged", "reviewing"] },
      }),
    }),
    prisma.subscription.count({
      where: customerSubscriptionWhere({ status: "active" }),
    }),
    prisma.featureFlag.findMany({ orderBy: { key: "asc" }, take: 8 }),
  ]);

  const totalFinished = completedJobs + failedJobs + blockedJobs;
  const successRate =
    totalFinished > 0 ? Math.round((completedJobs / totalFinished) * 100) : null;

  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    metrics: {
      users: { active: activeUsers, suspended: suspendedUsers },
      generation: {
        queued: queuedJobs,
        failed: failedJobs,
        blocked: blockedJobs,
        successRate,
      },
      moderation: { openReports },
      billing: { activeSubscriptions },
    },
    featureFlags: flags.map(featureFlagDto),
  };
}

export async function analyticsOverview(request: Request) {
  await actorWithPermission(request, "analytics.export");
  const { from, to, createdAt } = resolveWindow(
    queryParams(request, "GET /api/v2/admin/analytics/overview"),
    "analytics",
  );
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
    prisma.user.count({ where: customerUserWhere({ createdAt, deletedAt: null }) }),
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
      where: customerDreamcoinLedgerWhere({ createdAt, delta: { gt: 0 } }),
      _sum: { delta: true },
    }),
    prisma.dreamcoinLedger.aggregate({
      where: customerDreamcoinLedgerWhere({ createdAt, delta: { lt: 0 } }),
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
  const conversionRate = signups > 0 ? Math.round((payingUsers / signups) * 100) : 0;
  const statusCount = (status: string) =>
    generationByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const total = generationByStatus.reduce((sum, row) => sum + row._count._all, 0);
  const coinsGranted = grantedAgg._sum.delta ?? 0;
  const coinsSpent = spentAgg._sum.delta ?? 0;
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    funnel: {
      signups,
      activatedUsers: null,
      payingUsers: null,
      conversionRate: null,
      qualityState: "invalid" as const,
      validForDecisions: false as const,
      metricVersion: "legacy-v1" as const,
      reason:
        "Legacy activation used any generation job and conversion mixed unrelated windows; certified cohort metrics are not available yet.",
      legacyObserved: { activatedUsers, payingUsers, conversionRate },
    },
    generation: {
      total,
      completed: statusCount("completed"),
      failed: statusCount("failed"),
      blocked: statusCount("blocked"),
      qualityState: "directional" as const,
      validForDecisions: false as const,
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
  };
}

export async function abuseOverview(request: Request) {
  await actorWithPermission(request, "billing.read");
  const { from, to, createdAt } = resolveWindow(
    queryParams(request, "GET /api/v2/admin/risk/abuse"),
    "risk",
  );
  const [signupGroups, referralGroups, adjustGroups] = await Promise.all([
    prisma.analyticsEvent.groupBy({
      by: ["anonymousId"],
      where: customerAnalyticsEventWhere({
        name: "signup",
        anonymousId: { not: null },
        createdAt,
      }),
      _count: { _all: true },
    }),
    prisma.referral.groupBy({
      by: ["inviterId"],
      where: customerReferralWhere({ createdAt }),
      _count: { _all: true },
    }),
    prisma.dreamcoinLedger.groupBy({
      by: ["userId"],
      where: customerDreamcoinLedgerWhere({ reason: "admin_adjust", createdAt }),
      _sum: { delta: true },
      _count: { _all: true },
    }),
  ]);
  const flagged = signupGroups
    .filter((group) => group._count._all >= 2)
    .sort((a, b) => b._count._all - a._count._all)
    .slice(0, 20)
    .map((group) => group.anonymousId)
    .filter((id): id is string => Boolean(id));
  const events = flagged.length
    ? await prisma.analyticsEvent.findMany({
        where: customerAnalyticsEventWhere({
          name: "signup",
          anonymousId: { in: flagged },
        }),
        select: { anonymousId: true, userId: true },
      })
    : [];
  const accounts = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.anonymousId || !event.userId) continue;
    const users = accounts.get(event.anonymousId) ?? new Set<string>();
    users.add(event.userId);
    accounts.set(event.anonymousId, users);
  }
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    deviceClusters: flagged
      .map((anonymousId) => ({
        anonymousId,
        accountCount: accounts.get(anonymousId)?.size ?? 0,
        userIds: [...(accounts.get(anonymousId) ?? [])].slice(0, 10),
      }))
      .filter((cluster) => cluster.accountCount >= 2),
    referralAbuse: referralGroups
      .filter((group) => group._count._all >= 3)
      .map((group) => ({
        inviterId: group.inviterId,
        referralCount: group._count._all,
      }))
      .sort((a, b) => b.referralCount - a.referralCount)
      .slice(0, 20),
    adjustAnomalies: adjustGroups
      .map((group) => ({
        userId: group.userId,
        totalDelta: group._sum.delta ?? 0,
        count: group._count._all,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };
}

export async function providerOps(request: Request) {
  await actorWithPermission(request, "ops.queue.read");
  const { from, to, createdAt } = resolveWindow(
    queryParams(request, "GET /api/v2/admin/ops/providers"),
    "provider",
  );
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
  const providers = [...stats.entries()]
    .map(([provider, value]) => {
      const finished = value.completed + value.failed + value.blocked;
      const sorted = (latencies.get(provider) ?? []).sort((a, b) => a - b);
      return {
        provider,
        ...value,
        successRate:
          finished > 0 ? Math.round((value.completed / finished) * 100) : null,
        avgCostPerJob:
          value.total > 0 ? Math.round((value.coinsCost / value.total) * 10) / 10 : 0,
        latencyP50Ms: percentile(sorted, 50),
        latencyP95Ms: percentile(sorted, 95),
        latencySamples: sorted.length,
      };
    })
    .sort((a, b) => b.total - a.total);
  return {
    dataScope: OPERATIONAL_METRIC_DATA_SCOPE,
    window: { from: from.toISOString(), to: to.toISOString() },
    providers,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}
