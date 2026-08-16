// SPEC: Analytics 导出 / 留存 / feature-flag 监控三张只读面板。读 analytics.export。
// INTENT: 导出走 JSON 信封带 csv 字符串（UI 触发下载 + 可测），不回任何单用户明文。
//         留存与 flag 监控都是 legacy 口径，随响应一起发出「不可用于决策」的标注 ——
//         数字本身不能替运营做判断，标注才能。
import { prisma } from "@/server/lib/db";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerAnalyticsEventWhere,
  customerDreamcoinLedgerWhere,
  customerGenerationJobWhere,
  customerSubscriptionWhere,
  customerUserWhere,
} from "@/server/modules/metric-data-scope";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";

const ANALYTICS_EXPORT = "analytics.export" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export async function analyticsExport(request: Request) {
  await actorWithPermission(request, ANALYTICS_EXPORT);
  const { days } = queryParams(request, "GET /api/v2/admin/analytics/export");
  const since = new Date(Date.now() - days * DAY_MS);

  const [signups, ledger, events] = await Promise.all([
    prisma.user.count({ where: customerUserWhere({ createdAt: { gte: since } }) }),
    prisma.dreamcoinLedger.groupBy({
      by: ["reason"],
      where: customerDreamcoinLedgerWhere({ createdAt: { gte: since } }),
      _sum: { delta: true },
      _count: { _all: true },
    }),
    prisma.analyticsEvent.groupBy({
      by: ["name"],
      where: customerAnalyticsEventWhere({ createdAt: { gte: since } }),
      _count: { _all: true },
      orderBy: { _count: { name: "desc" } },
      take: 20,
    }),
  ]);

  const rows: string[] = [];
  rows.push(["section", "key", "value"].map(csvCell).join(","));
  rows.push(["funnel", "signups", signups].map(csvCell).join(","));
  rows.push(["funnel", "activatedUsers", "invalid_for_decisions"].map(csvCell).join(","));
  rows.push(["funnel", "conversion", "invalid_for_decisions"].map(csvCell).join(","));
  for (const row of ledger) {
    rows.push(["economy", row.reason, row._sum.delta ?? 0].map(csvCell).join(","));
  }
  for (const event of events) {
    rows.push(["event", event.name, event._count._all].map(csvCell).join(","));
  }
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: since.toISOString(), days },
    qualityState: "invalid" as const,
    validForDecisions: false as const,
    csv: rows.join("\n"),
  };
}

export async function analyticsRetention(request: Request) {
  await actorWithPermission(request, ANALYTICS_EXPORT);
  const { weeks } = queryParams(request, "GET /api/v2/admin/analytics/retention");
  const since = new Date(Date.now() - weeks * 7 * DAY_MS);
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: since.toISOString(), weeks },
    qualityState: "invalid" as const,
    validForDecisions: false as const,
    metricVersion: "legacy-v1" as const,
    reason:
      "Legacy D1/D7 used cumulative activity windows instead of exact calendar-day same-character QCE retention.",
    items: [],
  };
}

/**
 * SPEC: feature flag 的方向性大盘 —— 每个 flag 自创建以来的注册 / 激活 / 付费人数。
 * INTENT: 这不是实验分析。真正的受管实验在 `/api/v2/admin/experiments`，有不可变定义、
 *         稳定分臂与观测曝光；flag 监控只有「开了以后大盘长这样」，永远不能继承实验的
 *         lift 结论。两者共存是有意的，note 字段就是这条边界的对外声明。
 */
export async function experimentFlagMonitoring(request: Request) {
  await actorWithPermission(request, ANALYTICS_EXPORT);
  const flags = await prisma.featureFlag.findMany({ orderBy: { key: "asc" }, take: 50 });
  const items = await Promise.all(
    flags.map(async (flag) => {
      const since = flag.createdAt;
      const [signups, activated, paying] = await Promise.all([
        prisma.user.count({ where: customerUserWhere({ createdAt: { gte: since } }) }),
        prisma.generationJob
          .groupBy({
            by: ["userId"],
            where: customerGenerationJobWhere({ createdAt: { gte: since } }),
          })
          .then((rows) => rows.length),
        prisma.subscription
          .groupBy({
            by: ["userId"],
            where: customerSubscriptionWhere({
              status: "active",
              createdAt: { gte: since },
            }),
          })
          .then((rows) => rows.length),
      ]);
      return {
        key: flag.key,
        label: flag.label,
        enabled: flag.enabled,
        rolloutPercent: flag.rolloutPercent,
        hardPolicy: flag.hardPolicy,
        createdAt: flag.createdAt.toISOString(),
        metrics: { signups, activatedUsers: activated, payingUsers: paying },
      };
    }),
  );
  return {
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    items,
    note: "Directional customer-only metrics since each flag's creation. Precise randomized-arm A/B attribution requires per-user exposure events (deferred).",
  };
}
