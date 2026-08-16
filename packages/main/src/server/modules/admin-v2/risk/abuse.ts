import type { riskAbuseOverviewSchema } from "@idream/shared/admin/contracts";
import type { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerAnalyticsEventWhere,
  customerDreamcoinLedgerWhere,
  customerReferralWhere,
} from "@/server/modules/metric-data-scope";

type RiskAbuseOverview = z.infer<typeof riskAbuseOverviewSchema>;

/**
 * SPEC: 财务滥用信号总览 —— 多账号设备簇、推荐农场、人工调整异常。
 * INTENT: 只读。处置动作留在各自的来源域（封号在 access、发币在 billing），这里不提供任何写入，
 *         因为「看到信号」和「决定怎么办」是两次独立的授权。
 */
export async function abuseOverview(request: Request): Promise<RiskAbuseOverview> {
  await actorWithPermission(request, "billing.read");
  const { from, to, createdAt } = riskWindow(request);
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
  return {
    dataScope: {
      kind: CUSTOMER_METRIC_DATA_SCOPE.kind,
      includedDataClasses: [...CUSTOMER_METRIC_DATA_SCOPE.includedDataClasses],
      excludedDataClasses: [...CUSTOMER_METRIC_DATA_SCOPE.excludedDataClasses],
    },
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

function riskWindow(request: Request) {
  const query = queryParams(request, "GET /api/v2/admin/risk/abuse");
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw Errors.badRequest("Invalid risk window");
  }
  return { from, to, createdAt: { gte: from, lte: to } };
}
