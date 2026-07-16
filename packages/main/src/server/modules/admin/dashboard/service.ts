import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import {
  CUSTOMER_METRIC_DATA_SCOPE,
  customerContentReportWhere,
  customerGenerationJobWhere,
  customerSubscriptionWhere,
  customerUserWhere,
} from "@/server/modules/admin/shared/metric-data-scope";
import { actorWithPermission } from "@/server/modules/admin/shared/legacy-primitives";

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
    prisma.user.count({
      where: customerUserWhere({ status: "suspended" }),
    }),
    prisma.generationJob.count({
      where: customerGenerationJobWhere({
        status: {
          in: ["queued", "moderating_input", "running", "moderating_output"],
        },
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
    totalFinished > 0
      ? Math.round((completedJobs / totalFinished) * 100)
      : null;

  return ok({
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
    featureFlags: flags,
  });
}
