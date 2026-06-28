// SPEC: Analytics 导出 + 留存 cohort（ADMIN_PHASE3_DESIGN §5.3）。CSV 导出脱敏聚合；
//       按注册日 cohort 的 D1/D7 留存（纯 JS 计算，不用 raw SQL）。读 analytics.export。
// INTENT: 导出走 JSON 信封带 csv 字符串（便于 UI 触发下载 + 测试），不回任何单用户明文。
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import { actorWithPermission, clampInt } from "@/server/modules/admin/service";

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

  const [signups, activatedJobs, payingSubs, ledger, events] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.generationJob.groupBy({ by: ["userId"], where: { createdAt: { gte: since } } }),
    prisma.subscription.groupBy({ by: ["userId"], where: { status: "active" } }),
    prisma.dreamcoinLedger.groupBy({
      by: ["reason"],
      where: { createdAt: { gte: since } },
      _sum: { delta: true },
      _count: { _all: true },
    }),
    prisma.analyticsEvent.groupBy({
      by: ["name"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { name: "desc" } },
      take: 20,
    }),
  ]);

  const rows: string[] = [];
  rows.push(["section", "key", "value"].map(csvCell).join(","));
  rows.push(["funnel", "signups", signups].map(csvCell).join(","));
  rows.push(["funnel", "activatedUsers", activatedJobs.length].map(csvCell).join(","));
  rows.push(["funnel", "payingUsers", payingSubs.length].map(csvCell).join(","));
  for (const r of ledger) {
    rows.push(["economy", r.reason, r._sum.delta ?? 0].map(csvCell).join(","));
  }
  for (const e of events) {
    rows.push(["event", e.name, e._count._all].map(csvCell).join(","));
  }
  const csv = rows.join("\n");
  return ok({ window: { from: since.toISOString(), days }, csv });
}

export async function analyticsRetention(request: Request): Promise<Response> {
  await actorWithPermission(request, ANALYTICS_EXPORT);
  const url = new URL(request.url);
  const weeks = clampInt(url.searchParams.get("weeks"), 1, 12, 4);
  const since = new Date(Date.now() - weeks * 7 * DAY_MS);

  const users = await prisma.user.findMany({
    where: { createdAt: { gte: since } },
    select: { id: true, createdAt: true },
    take: 5000,
  });
  const userIds = users.map((u) => u.id);
  const events = userIds.length
    ? await prisma.analyticsEvent.findMany({
        where: { userId: { in: userIds }, name: { not: "signup" }, createdAt: { gte: since } },
        select: { userId: true, createdAt: true },
        take: 50_000,
      })
    : [];

  const activityByUser = new Map<string, number[]>();
  for (const event of events) {
    if (!event.userId) continue;
    const list = activityByUser.get(event.userId) ?? [];
    list.push(event.createdAt.getTime());
    activityByUser.set(event.userId, list);
  }

  const cohorts = new Map<string, { size: number; d1: number; d7: number }>();
  for (const user of users) {
    const day = user.createdAt.toISOString().slice(0, 10);
    const cohort = cohorts.get(day) ?? { size: 0, d1: 0, d7: 0 };
    cohort.size += 1;
    const t0 = user.createdAt.getTime();
    const acts = activityByUser.get(user.id) ?? [];
    if (acts.some((t) => t > t0 && t <= t0 + DAY_MS)) cohort.d1 += 1;
    if (acts.some((t) => t > t0 && t <= t0 + 7 * DAY_MS)) cohort.d7 += 1;
    cohorts.set(day, cohort);
  }

  const items = [...cohorts.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([cohort, c]) => ({
      cohort,
      size: c.size,
      d1: c.d1,
      d7: c.d7,
      d1Rate: c.size > 0 ? Math.round((c.d1 / c.size) * 100) : 0,
      d7Rate: c.size > 0 ? Math.round((c.d7 / c.size) * 100) : 0,
    }));

  return ok({ window: { from: since.toISOString(), weeks }, items });
}
