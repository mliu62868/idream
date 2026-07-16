// SPEC: 实验度量（ADMIN_PHASE4_DESIGN §4）。列 FeatureFlag + 自创建以来的方向性大盘指标。
// INTENT: 只读，读 analytics.export。诚实标注：非随机分臂归因（需逐用户曝光埋点，延后）。
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerGenerationJobWhere,
  customerSubscriptionWhere,
  customerUserWhere,
} from "@/server/modules/admin/shared/metric-data-scope";
import { actorWithPermission } from "@/server/modules/admin/shared/legacy-primitives";

export async function listExperiments(request: Request): Promise<Response> {
  await actorWithPermission(request, "analytics.export");
  const flags = await prisma.featureFlag.findMany({ orderBy: { key: "asc" }, take: 50 });
  const items = await Promise.all(
    flags.map(async (flag) => {
      const since = flag.createdAt;
      const [signups, activated, paying] = await Promise.all([
        prisma.user.count({
          where: customerUserWhere({ createdAt: { gte: since } }),
        }),
        prisma.generationJob
          .groupBy({
            by: ["userId"],
            where: customerGenerationJobWhere({
              createdAt: { gte: since },
            }),
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
        createdAt: flag.createdAt,
        metrics: { signups, activatedUsers: activated, payingUsers: paying },
      };
    }),
  );
  return ok({
    dataScope: CUSTOMER_METRIC_DATA_SCOPE,
    items,
    note: "Directional customer-only metrics since each flag's creation. Precise randomized-arm A/B attribution requires per-user exposure events (deferred).",
  });
}
