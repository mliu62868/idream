import { z } from "zod";
import { creativeRunCreateRequestSchema } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
} from "../shared/legacy-primitives";
import {
  creativeRunDTOs,
  creativeRunInclude,
} from "@/server/modules/admin-v2/creative/run-projection";
import { estimateCreativeRunCost } from "@/server/modules/admin-v2/creative/run-create";

// SPEC: `/api/v1/admin/content/production/*` 的兼容层 —— 只读 Run，加三个已退休的
// item 动作。
// INTENT: Run 的创建与审阅权威都在 admin-v2/creative；这里不复制任何判断，读投影和
// 成本预估都向那边要。item 的 approve/reject/regenerate 在 Creative Run 不可变决策
// 落地时就已停用，保留为带 repairPath 的显式冲突，而不是静默 404。

const productionPurposeSchema = creativeRunCreateRequestSchema.shape.purpose;

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

const productionEstimateSchema = z.object({
  profileId: z.string().trim().min(1).max(180),
  count: z.number().int().min(1).max(40).default(4),
}).strict();

const itemReviewSchema = z.object({
  reviewNote: optionalText(2_000),
  description: optionalText(2_000),
  rating: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(24).default([]),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const itemRegenerateSchema = z.object({
  brief: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listProductionBatches(request: Request) {
  await actorWithPermission(request, "content.asset.read");
  const url = new URL(request.url);
  const purpose = productionPurposeSchema.safeParse(url.searchParams.get("purpose")).data;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const batches = await prisma.contentProductionBatch.findMany({
    where: {
      purpose,
      status,
      targetId,
    },
    include: creativeRunInclude,
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
  });
  return ok({ items: await creativeRunDTOs(batches) });
}

export async function estimateProductionBatch(request: Request) {
  await actorWithPermission(request, "content.asset.read");
  const body = productionEstimateSchema.parse(await jsonBody(request));
  return ok(await estimateCreativeRunCost(body));
}

export async function getProductionBatch(request: Request, id: string) {
  await actorWithPermission(request, "content.asset.read");
  const batch = await prisma.contentProductionBatch.findUnique({
    where: { id },
    include: creativeRunInclude,
  });
  if (!batch) throw Errors.notFound("Production batch not found");
  const [dto] = await creativeRunDTOs([batch]);
  return ok({ batch: dto });
}

export async function approveProductionItem(request: Request, id: string): Promise<Response> {
  await actorWithPermission(request, "content.asset.review");
  const body = itemReviewSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const item = await prisma.contentProductionItem.findUnique({
    where: { id },
    select: { batchId: true },
  });
  if (!item) throw Errors.notFound("Production item not found");
  throw Errors.conflict("Legacy item approval is disabled; record an immutable Creative Run decision", {
    code: "creative_run_review_required",
    repairPath: `/admin/creative/runs/${item.batchId}`,
  });
}

export async function rejectProductionItem(request: Request, id: string): Promise<Response> {
  await actorWithPermission(request, "content.asset.review");
  const body = itemReviewSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const item = await prisma.contentProductionItem.findUnique({
    where: { id },
    select: { batchId: true },
  });
  if (!item) throw Errors.notFound("Production item not found");
  throw Errors.conflict("Legacy item rejection is disabled; record an immutable Creative Run decision", {
    code: "creative_run_review_required",
    repairPath: `/admin/creative/runs/${item.batchId}`,
  });
}

export async function regenerateProductionItem(request: Request, id: string): Promise<Response> {
  await actorWithPermission(request, "content.production.write");
  const body = itemRegenerateSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const sourceItem = await prisma.contentProductionItem.findUnique({
    where: { id },
    select: { batchId: true },
  });
  if (!sourceItem) throw Errors.notFound("Production item not found");
  throw Errors.conflict(
    "Legacy item regeneration is disabled; retry the frozen failed set through the Creative Run command",
    {
      code: "creative_run_command_required",
      repairPath: `/admin/creative/runs/${sourceItem.batchId}`,
    },
  );
}
