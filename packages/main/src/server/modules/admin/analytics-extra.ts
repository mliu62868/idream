// SPEC: Analytics 导出 + 留存 cohort（ADMIN_PHASE3_DESIGN §5.3）。CSV 导出脱敏聚合；
//       按注册日 cohort 的 D1/D7 留存（纯 JS 计算，不用 raw SQL）。读 analytics.export。
// INTENT: 导出走 JSON 信封带 csv 字符串（便于 UI 触发下载 + 测试），不回任何单用户明文。
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerAnalyticsEventWhere,
  customerDreamcoinLedgerWhere,
  customerUserWhere,
} from "@/server/modules/metric-data-scope";
import { actorWithPermission, clampInt } from "@/server/modules/admin/shared/legacy-primitives";

const ANALYTICS_EXPORT = "analytics.export" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export async function analyticsExport(request: Request): Promise<Response> {
  await actorWithPermission(request, ANALYTICS_EXPORT);
  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get("days"), 1, 365, 30);
  const since = new Date(Date.now() - days * DAY_MS);

  const [signups, ledger, events] = await Promise.all([
    prisma.user.count({
      where: customerUserWhere({ createdAt: { gte: since } }),
    }),
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
  for (const r of ledger) {
    rows.push(["economy", r.reason, r._sum.delta ?? 0].map(csvCell).join(","));
  }
  for (const e of events) {
    rows.push(["event", e.name, e._count._all].map(csvCell).join(","));
  }
  const csv = rows.join("\n");
  return ok({
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: since.toISOString(), days },
    qualityState: "invalid",
    validForDecisions: false,
    csv,
  });
}

export async function analyticsRetention(request: Request): Promise<Response> {
  await actorWithPermission(request, ANALYTICS_EXPORT);
  const url = new URL(request.url);
  const weeks = clampInt(url.searchParams.get("weeks"), 1, 12, 4);
  const since = new Date(Date.now() - weeks * 7 * DAY_MS);

  return ok({
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    window: { from: since.toISOString(), weeks },
    qualityState: "invalid",
    validForDecisions: false,
    metricVersion: "legacy-v1",
    reason:
      "Legacy D1/D7 used cumulative activity windows instead of exact calendar-day same-character QCE retention.",
    items: [],
  });
}
