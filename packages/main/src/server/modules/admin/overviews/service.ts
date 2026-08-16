import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/shared/legacy-primitives";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerAnalyticsEventWhere,
  customerDreamcoinLedgerWhere,
  customerGenerationJobWhere,
  customerReferralWhere,
  customerSubscriptionWhere,
  customerUserWhere,
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

export async function abuseOverview(request: Request) {
  await actorWithPermission(request, "billing.read");
  const { from, to, createdAt } = windowFromRequest(request, "risk");
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
      where: customerDreamcoinLedgerWhere({
        reason: "admin_adjust",
        createdAt,
      }),
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
  return ok({
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
