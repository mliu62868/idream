// SPEC: 后台两张只读运营大盘 —— dashboard 与 analytics overview。
// INTENT: legacy 口径（activation / conversion）保留 `qualityState:"invalid"` 的诚实标注，
//         而不是把没认证的数字直接当结论发出去。
// INVARIANT: 同住 v1 `admin/overviews/service.ts` 的 abuseOverview / providerOps 分属
//         另外两路，不在这里 —— 那个文件由三方各挖各的，谁都不许重排。
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerAnalyticsEventWhere,
  customerContentReportWhere,
  customerDreamcoinLedgerWhere,
  customerGenerationJobWhere,
  customerSubscriptionWhere,
  customerUserWhere,
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
