// SPEC: 生成 profile 健康度 + 发布前 dry-run（ADMIN_PHASE3_DESIGN §5.1 / ADMIN_CONSOLE_PLAN §6.2）。
//       发布人工决策的依据：从 GenerationJob 只读聚合成功率/延迟/blocked/refund；dry-run 对样本
//       矩阵做配置校验并写入 dryRunSummary（零迁移，复用既有字段）。
// INTENT: 读 generation.config.read、写 generation.config.write；dry-run 不调外部 provider
//         （受控环境 mock），只做确定性配置校验 + 留痕，给发布前一个可审计的 reference。
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  toInputJson,
  writeAudit,
} from "@/server/modules/admin/service";

const CONFIG_READ = "generation.config.read" as const;
const CONFIG_WRITE = "generation.config.write" as const;

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return Math.round(sortedMs[idx]);
}

export async function profileHealth(request: Request, id: string): Promise<Response> {
  await actorWithPermission(request, CONFIG_READ);
  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get("days"), 1, 365, 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const profile = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!profile) throw Errors.notFound("Model profile not found");

  const where = {
    profileId: { in: [profile.id, profile.profileKey] },
    createdAt: { gte: since },
  };
  const [total, completed, failed, blocked, refunded, done] = await Promise.all([
    prisma.generationJob.count({ where }),
    prisma.generationJob.count({ where: { ...where, status: "completed" } }),
    prisma.generationJob.count({ where: { ...where, status: "failed" } }),
    prisma.generationJob.count({ where: { ...where, status: "blocked" } }),
    prisma.generationJob.count({ where: { ...where, status: "refunded" } }),
    prisma.generationJob.findMany({
      where: { ...where, status: "completed", completedAt: { not: null } },
      select: { createdAt: true, completedAt: true },
      take: 1000,
    }),
  ]);

  const durations = done
    .map((job) => (job.completedAt ? job.completedAt.getTime() - job.createdAt.getTime() : 0))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  const finished = completed + failed + blocked;

  return ok({
    profileId: profile.id,
    profileKey: profile.profileKey,
    window: { from: since.toISOString(), days },
    metrics: {
      total,
      completed,
      failed,
      blocked,
      refunded,
      successRate: finished > 0 ? Math.round((completed / finished) * 100) : 100,
      blockedRate: finished > 0 ? Math.round((blocked / finished) * 100) : 0,
      refundRate: total > 0 ? Math.round((refunded / total) * 100) : 0,
      latencyP50Ms: percentile(durations, 50),
      latencyP95Ms: percentile(durations, 95),
      latencySamples: durations.length,
    },
  });
}

const dryRunSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

// 发布前 dry-run：对样本矩阵（useCase × orientation）做确定性配置校验，写 dryRunSummary。
export async function profileDryRun(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, CONFIG_WRITE);
  const body = dryRunSchema.parse(await jsonBody(request));
  if (body.confirmation !== id && body.confirmation !== "DRYRUN") {
    throw Errors.badRequest("Confirmation did not match dry-run target");
  }
  const profile = await prisma.generationModelProfile.findUnique({ where: { id } });
  if (!profile) throw Errors.notFound("Model profile not found");

  const orientations = Array.isArray(profile.allowedOrientations)
    ? (profile.allowedOrientations as unknown[]).filter((o): o is string => typeof o === "string")
    : [];
  const useCases = profile.mode === "video" ? ["freeplay"] : ["character", "freeplay"];
  const samples: Array<{ useCase: string; orientation: string; ok: boolean; issues: string[] }> = [];
  for (const useCase of useCases) {
    for (const orientation of orientations.length ? orientations : ["1:1"]) {
      const issues: string[] = [];
      if (!profile.pipelineModel?.trim()) issues.push("pipelineModel empty");
      if (profile.maxCount < 1) issues.push("maxCount < 1");
      if (profile.steps < 1) issues.push("steps < 1");
      if (!orientations.length) issues.push("no allowedOrientations");
      samples.push({ useCase, orientation, ok: issues.length === 0, issues });
    }
  }
  const passed = samples.filter((s) => s.ok).length;
  const summary = {
    source: "admin_console_dry_run",
    ranBy: actor.id,
    samples,
    passed,
    total: samples.length,
    status: passed === samples.length ? "pass" : "fail",
  };
  await prisma.generationModelProfile.update({
    where: { id },
    data: { dryRunSummary: toInputJson(summary) },
  });
  await writeAudit(request, actor, {
    action: "generation.profile.dry_run",
    targetType: "generation_model_profile",
    targetId: id,
    reason: body.reason,
    after: { status: summary.status, passed, total: samples.length },
  });
  return ok({ dryRun: summary });
}
