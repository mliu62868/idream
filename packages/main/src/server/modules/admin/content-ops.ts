import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { dimensionsForImageOrientation } from "@/server/modules/ourdream/generation-dimensions";
import { generationCostDreamcoins } from "@/server/lib/generation-pricing";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  clampInt,
  enqueueExistingGenerationJob,
  jsonBody,
  toInputJson,
  writeAudit,
  type AdminActor,
} from "./service";
import {
  markProductionItemFailed,
  refreshContentProductionBatchStats,
} from "./content-production-state";

const productionPurposeSchema = z.enum([
  "character_cover",
  "character_hero",
  "character_chat",
  "feed",
  "homepage",
  "seo",
  "template_cover",
  "campaign",
  "model_eval",
]);

const productionTargetTypeSchema = z.enum([
  "character",
  "route_page",
  "campaign",
  "template",
  "none",
]);

const placementSlotSchema = z.enum([
  "character_avatar",
  "character_hero",
  "feed_card",
  "homepage_strip",
  "seo_article",
  "template_cover",
  "campaign",
]);

const placementStatusSchema = z.enum(["draft", "scheduled", "published", "paused", "archived"]);
const assetReviewStatusSchema = z.enum(["draft", "generated", "approved", "rejected", "published", "archived"]);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

const productionBatchCreateSchema = z.object({
  title: optionalText(160),
  purpose: productionPurposeSchema,
  targetType: productionTargetTypeSchema.default("none"),
  targetId: optionalText(180),
  profileId: z.string().trim().min(1).max(180),
  recipeId: optionalText(180),
  presetIds: z.array(z.string().trim().min(1).max(180)).max(12).default([]),
  orientation: optionalText(20),
  count: z.number().int().min(1).max(24).default(4),
  brief: optionalText(2_000),
  reason: optionalText(2_000),
});

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

const assetPatchSchema = z.object({
  status: assetReviewStatusSchema.optional(),
  purpose: productionPurposeSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(48).optional(),
  description: optionalText(2_000),
  reviewNote: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

const assetBulkSchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(180)).min(1).max(100),
  status: assetReviewStatusSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(48).optional(),
  description: optionalText(2_000),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(20_000),
});

const placementCreateSchema = z.object({
  mediaAssetId: z.string().trim().min(1).max(180),
  slot: placementSlotSchema,
  targetType: productionTargetTypeSchema.exclude(["none"]),
  targetId: z.string().trim().min(1).max(180),
  status: placementStatusSchema.default("published"),
  scheduledAt: optionalText(80),
  metadata: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().trim().min(3).max(2_000),
});

const placementPatchSchema = z.object({
  status: placementStatusSchema.optional(),
  scheduledAt: optionalText(80),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export const productionBatchInclude = {
  createdBy: { select: { id: true, email: true, displayName: true, name: true } },
  items: {
    include: {
      job: { include: { assets: true } },
      mediaAsset: true,
    },
    orderBy: { itemIndex: "asc" },
  },
} satisfies Prisma.ContentProductionBatchInclude;

const contentAssetInclude = {
  sourceJob: true,
  productionItems: {
    include: { batch: true },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
  placements: { orderBy: { createdAt: "desc" } },
} satisfies Prisma.MediaAssetInclude;

const placementInclude = {
  mediaAsset: true,
  createdBy: { select: { id: true, email: true, displayName: true, name: true } },
} satisfies Prisma.MediaAssetPlacementInclude;

type ProductionBatchWithItems = Prisma.ContentProductionBatchGetPayload<{
  include: typeof productionBatchInclude;
}>;

type ContentAssetWithRelations = Prisma.MediaAssetGetPayload<{
  include: typeof contentAssetInclude;
}>;

type PlacementWithRelations = Prisma.MediaAssetPlacementGetPayload<{
  include: typeof placementInclude;
}>;

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
    include: productionBatchInclude,
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
  });
  return ok({ items: batches.map(productionBatchDTO) });
}

export type ProductionBatchCreateInput = z.infer<typeof productionBatchCreateSchema>;

// NOTE: takes `request` + full `AdminActor` (not just `actor: {id}`) because writeAudit()
// below needs actor.role plus request headers (x-request-id/x-forwarded-for/user-agent)
// for the audit row — callers extracted after actorWithPermission() already have both.
export async function createProductionBatchCore(
  request: Request,
  actor: AdminActor,
  body: ProductionBatchCreateInput,
): Promise<Response> {
  const profile = await resolveProductionProfile(body.profileId);
  const recipe = await resolveProductionRecipe(body.recipeId, body.targetType);
  const target = await resolveProductionTarget(body.targetType, body.targetId);
  const presets = await prisma.generationPreset.findMany({
    where: { id: { in: body.presetIds }, scope: "built_in", status: "active" },
  });
  if (presets.length !== body.presetIds.length) {
    throw Errors.badRequest("Production batch presets must be active built-in presets");
  }
  const allowedOrientations = jsonStringArray(profile.allowedOrientations);
  const orientation = body.orientation ?? allowedOrientations[0] ?? "4:5";
  if (allowedOrientations.length > 0 && !allowedOrientations.includes(orientation)) {
    throw Errors.badRequest("Orientation is not allowed for this profile", {
      orientation,
      allowedOrientations,
    });
  }
  const dimensions = dimensionsForImageOrientation({
    orientation,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
  const title =
    body.title ??
    `${purposeLabel(body.purpose)} ${new Date().toISOString().slice(0, 10)}`;
  const presetFragment = presetPromptFragment(body.presetIds, presets);
  const prompt = productionPrompt({
    purpose: body.purpose,
    target,
    recipeBody: recipe.body,
    presetFragment,
    brief: body.brief,
  });
  const controls = productionControls({
    orientation,
    dimensions,
    profile,
    presets,
  });
  const perItemCostDreamcoins = await generationCostDreamcoins(
    "image",
    1,
    profile.costMultiplier ?? 1,
  );

  const batch = await prisma.$transaction(async (tx) => {
    const createdBatch = await tx.contentProductionBatch.create({
      data: {
        title,
        purpose: body.purpose,
        targetType: body.targetType,
        targetId: body.targetId ?? null,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        recipeId: recipe.templateKey,
        recipeVersion: recipe.version,
        presetIds: toInputJson(body.presetIds),
        orientation,
        brief: body.brief ?? null,
        count: body.count,
        totalItems: body.count,
        estimatedCostDreamcoins: perItemCostDreamcoins * body.count,
        status: "queued",
        createdById: actor.id,
      },
    });

    for (let itemIndex = 0; itemIndex < body.count; itemIndex += 1) {
      const item = await tx.contentProductionItem.create({
        data: {
          batchId: createdBatch.id,
          itemIndex,
          status: "queued",
          tags: [],
        },
      });
      const job = await tx.generationJob.create({
        data: {
          userId: actor.id,
          characterId: body.targetType === "character" ? body.targetId ?? null : null,
          mode: "image",
          prompt,
          negativePrompt: recipe.negativeBase,
          controls: toInputJson(controls),
          presetIds: toInputJson(body.presetIds),
          model: profile.pipelineModel,
          profileId: profile.profileKey,
          profileVersion: profile.version,
          promptTemplateId: recipe.templateKey,
          promptTemplateVersion: recipe.version,
          orientation,
          outputCount: 1,
          status: "queued",
          costDreamcoins: perItemCostDreamcoins,
          provider: profile.runner,
          sourceType: "content_production_item",
          sourceId: item.id,
          sourceMeta: toInputJson({
            batchId: createdBatch.id,
            purpose: body.purpose,
            targetType: body.targetType,
            targetId: body.targetId ?? null,
            itemIndex,
          }),
        },
      });
      await tx.contentProductionItem.update({
        where: { id: item.id },
        data: { jobId: job.id },
      });
      await appendProductionJobEvent(tx, job.id, "created", "Content production job accepted", {
        batchId: createdBatch.id,
        itemId: item.id,
        purpose: body.purpose,
      });
      await appendProductionJobEvent(tx, job.id, "queued", "Content production job queued", {});
    }

    await refreshContentProductionBatchStats(tx, createdBatch.id);
    return tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: createdBatch.id },
      include: productionBatchInclude,
    });
  });

  for (const job of batch.items.map((item) => item.job).filter((job): job is NonNullable<typeof job> => Boolean(job))) {
    try {
      await enqueueExistingGenerationJob(job);
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        await tx.generationJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            errorCode: "queue_enqueue_failed",
            completedAt: new Date(),
          },
        });
        await markProductionItemFailed(tx, job.id);
        await appendProductionJobEvent(tx, job.id, "failed", "Content production enqueue failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      throw Errors.internal("Generation queue unavailable", { jobId: job.id });
    }
  }

  await writeAudit(request, actor, {
    action: "content.production.batch.create",
    targetType: "content_production_batch",
    targetId: batch.id,
    reason: body.reason,
    after: {
      purpose: batch.purpose,
      count: batch.totalItems,
      profileId: batch.profileId,
      recipeId: batch.recipeId,
    },
  });
  return ok({ batch: productionBatchDTO(batch) }, { status: 202 });
}

export async function createProductionBatch(request: Request) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = productionBatchCreateSchema.parse(await jsonBody(request));
  return createProductionBatchCore(request, actor, body);
}

export async function getProductionBatch(request: Request, id: string) {
  await actorWithPermission(request, "content.asset.read");
  const batch = await prisma.contentProductionBatch.findUnique({
    where: { id },
    include: productionBatchInclude,
  });
  if (!batch) throw Errors.notFound("Production batch not found");
  return ok({ batch: productionBatchDTO(batch) });
}

export async function approveProductionItem(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = itemReviewSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const item = await itemWithAsset(id);
  const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
  if (!asset) throw Errors.badRequest("Production item has no generated asset to approve");

  const updated = await prisma.$transaction(async (tx) => {
    await tx.contentProductionItem.update({
      where: { id },
      data: {
        mediaAssetId: asset.id,
      status: "approved",
      reviewNote: body.reviewNote,
      rating: body.rating,
        tags: toInputJson(body.tags),
        reviewedById: actor.id,
        reviewedAt: new Date(),
      },
    });
    await patchAssetMetadata(tx, asset.id, {
      status: "approved",
      purpose: item.batch.purpose,
      tags: body.tags,
      reviewNote: body.reviewNote,
      description: body.description,
      sourceBatchId: item.batchId,
    });
    await refreshContentProductionBatchStats(tx, item.batchId);
    return tx.contentProductionItem.findUniqueOrThrow({
      where: { id },
      include: {
        batch: true,
        job: { include: { assets: true } },
        mediaAsset: true,
      },
    });
  });
  await writeAudit(request, actor, {
    action: "content.production.item.approve",
    targetType: "content_production_item",
    targetId: id,
    reason: body.reason,
    after: {
      mediaAssetId: asset.id,
      tags: body.tags,
      rating: body.rating ?? null,
    },
  });
  return ok({ item: productionItemDTO(updated) });
}

export async function rejectProductionItem(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = itemReviewSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const item = await itemWithAsset(id);
  const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
  const updated = await prisma.$transaction(async (tx) => {
    await tx.contentProductionItem.update({
      where: { id },
      data: {
        mediaAssetId: asset?.id,
        status: "rejected",
        reviewNote: body.reviewNote,
        rating: body.rating,
        tags: toInputJson(body.tags),
        reviewedById: actor.id,
        reviewedAt: new Date(),
      },
    });
    if (asset) {
      await patchAssetMetadata(tx, asset.id, {
        status: "rejected",
        purpose: item.batch.purpose,
        tags: body.tags,
        reviewNote: body.reviewNote,
        description: body.description,
        sourceBatchId: item.batchId,
      });
    }
    await refreshContentProductionBatchStats(tx, item.batchId);
    return tx.contentProductionItem.findUniqueOrThrow({
      where: { id },
      include: {
        batch: true,
        job: { include: { assets: true } },
        mediaAsset: true,
      },
    });
  });
  await writeAudit(request, actor, {
    action: "content.production.item.reject",
    targetType: "content_production_item",
    targetId: id,
    reason: body.reason,
    after: { mediaAssetId: asset?.id ?? null, tags: body.tags },
  });
  return ok({ item: productionItemDTO(updated) });
}

export async function regenerateProductionItem(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.production.write");
  const body = itemRegenerateSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match production item");
  }
  const sourceItem = await prisma.contentProductionItem.findUnique({
    where: { id },
    include: { batch: true },
  });
  if (!sourceItem) throw Errors.notFound("Production item not found");
  const profile = await resolveProductionProfile(
    sourceItem.batch.profileId ?? "",
    sourceItem.batch.profileVersion ?? undefined,
  );
  const recipe = await resolveProductionRecipe(
    sourceItem.batch.recipeId ?? undefined,
    sourceItem.batch.targetType,
    sourceItem.batch.recipeVersion ?? undefined,
  );
  const target = await resolveProductionTarget(sourceItem.batch.targetType, sourceItem.batch.targetId ?? undefined);
  const presetIds = jsonStringArray(sourceItem.batch.presetIds);
  const presets = await prisma.generationPreset.findMany({
    where: { id: { in: presetIds }, scope: "built_in", status: "active" },
  });
  const orientation =
    sourceItem.batch.orientation ??
    jsonStringArray(profile.allowedOrientations)[0] ??
    "4:5";
  const dimensions = dimensionsForImageOrientation({
    orientation,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
  const controls = productionControls({ orientation, dimensions, profile, presets });
  const prompt = productionPrompt({
    purpose: sourceItem.batch.purpose as z.infer<typeof productionPurposeSchema>,
    target,
    recipeBody: recipe.body,
    presetFragment: presetPromptFragment(presetIds, presets),
    brief: body.brief ?? sourceItem.batch.brief ?? undefined,
  });
  const perItemCostDreamcoins = await generationCostDreamcoins(
    "image",
    1,
    profile.costMultiplier ?? 1,
  );

  const batch = await prisma.$transaction(async (tx) => {
    await tx.contentProductionItem.update({
      where: { id },
      data: { status: "regenerate_requested", reviewNote: body.reason },
    });
    await tx.contentProductionBatch.update({
      where: { id: sourceItem.batchId },
      data: { estimatedCostDreamcoins: { increment: perItemCostDreamcoins } },
    });
    const maxIndex = await tx.contentProductionItem.aggregate({
      where: { batchId: sourceItem.batchId },
      _max: { itemIndex: true },
    });
    const item = await tx.contentProductionItem.create({
      data: {
        batchId: sourceItem.batchId,
        itemIndex: (maxIndex._max.itemIndex ?? sourceItem.itemIndex) + 1,
        status: "queued",
        tags: [],
      },
    });
    const job = await tx.generationJob.create({
      data: {
        userId: actor.id,
        characterId: sourceItem.batch.targetType === "character" ? sourceItem.batch.targetId : null,
        mode: "image",
        prompt,
        negativePrompt: recipe.negativeBase,
        controls: toInputJson(controls),
        presetIds: toInputJson(presetIds),
        model: profile.pipelineModel,
        profileId: profile.profileKey,
        profileVersion: profile.version,
        promptTemplateId: recipe.templateKey,
        promptTemplateVersion: recipe.version,
        orientation,
        outputCount: 1,
        status: "queued",
        costDreamcoins: perItemCostDreamcoins,
        provider: profile.runner,
        sourceType: "content_production_item",
        sourceId: item.id,
        sourceMeta: toInputJson({
          batchId: sourceItem.batchId,
          purpose: sourceItem.batch.purpose,
          targetType: sourceItem.batch.targetType,
          targetId: sourceItem.batch.targetId,
          itemIndex: item.itemIndex,
          variantOf: id,
        }),
      },
    });
    await tx.contentProductionItem.update({
      where: { id: item.id },
      data: { jobId: job.id },
    });
    await appendProductionJobEvent(tx, job.id, "created", "Content production variation accepted", {
      batchId: sourceItem.batchId,
      itemId: item.id,
      variantOf: id,
    });
    await appendProductionJobEvent(tx, job.id, "queued", "Content production variation queued", {});
    await refreshContentProductionBatchStats(tx, sourceItem.batchId);
    return tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: sourceItem.batchId },
      include: productionBatchInclude,
    });
  });

  const queuedJob = batch.items
    .map((item) => item.job)
    .filter((job): job is NonNullable<typeof job> => Boolean(job))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (queuedJob) {
    try {
      await enqueueExistingGenerationJob(queuedJob);
    } catch (error) {
      await prisma.$transaction(async (tx) => {
        await tx.generationJob.update({
          where: { id: queuedJob.id },
          data: {
            status: "failed",
            errorCode: "queue_enqueue_failed",
            completedAt: new Date(),
          },
        });
        await markProductionItemFailed(tx, queuedJob.id);
        await appendProductionJobEvent(tx, queuedJob.id, "failed", "Content production variation enqueue failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      throw Errors.internal("Generation queue unavailable", { jobId: queuedJob.id });
    }
  }

  await writeAudit(request, actor, {
    action: "content.production.item.regenerate",
    targetType: "content_production_item",
    targetId: id,
    reason: body.reason,
    after: { batchId: sourceItem.batchId, jobId: queuedJob?.id ?? null },
  });
  return ok({ batch: productionBatchDTO(batch) }, { status: 202 });
}

export async function listContentAssets(request: Request) {
  await actorWithPermission(request, "content.asset.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim() || undefined;
  const productionItemStatus = status === "archived" ? undefined : status;
  const purpose = productionPurposeSchema.safeParse(url.searchParams.get("purpose")).data;
  const profileId = url.searchParams.get("profileId")?.trim() || undefined;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const assets = await prisma.mediaAsset.findMany({
    where: {
      type: "image",
      deletedAt: null,
      sourceJob: profileId ? { profileId } : undefined,
      productionItems: {
        some: {
          status: productionItemStatus,
          batch: {
            purpose,
            targetId,
          },
        },
      },
    },
    include: contentAssetInclude,
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 200, 80),
  });
  const tag = url.searchParams.get("tag")?.trim();
  const statusFiltered =
    status === "archived"
      ? assets.filter((asset) => platformAssetMetadata(asset).status === "archived")
      : status
        ? assets.filter((asset) => platformAssetMetadata(asset).status !== "archived")
        : assets;
  const filtered = tag
    ? statusFiltered.filter((asset) => assetTags(asset).includes(tag))
    : statusFiltered;
  return ok({ items: filtered.map(contentAssetDTO) });
}

export async function getContentAsset(request: Request, id: string) {
  await actorWithPermission(request, "content.asset.read");
  const asset = await prisma.mediaAsset.findUnique({
    where: { id },
    include: contentAssetInclude,
  });
  if (!asset || asset.deletedAt) throw Errors.notFound("Content asset not found");
  return ok({ asset: contentAssetDTO(asset) });
}

export async function patchContentAsset(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = assetPatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match asset");
  }
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.deletedAt) throw Errors.notFound("Content asset not found");
  const updated = await prisma.$transaction(async (tx) => {
    await patchAssetMetadata(tx, id, {
      status: body.status,
      purpose: body.purpose,
      tags: body.tags,
      description: body.description,
      reviewNote: body.reviewNote,
    });
    if (body.tags !== undefined || body.reviewNote !== undefined) {
      await tx.contentProductionItem.updateMany({
        where: { mediaAssetId: id },
        data: {
          tags: body.tags ? toInputJson(body.tags) : undefined,
          reviewNote: body.reviewNote,
        },
      });
    }
    if (body.status && ["approved", "rejected", "published"].includes(body.status)) {
      await tx.contentProductionItem.updateMany({
        where: {
          mediaAssetId: id,
          status: { notIn: ["published"] },
        },
        data: {
          status: body.status,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          tags: body.tags ? toInputJson(body.tags) : undefined,
          reviewNote: body.reviewNote,
        },
      });
      const items = await tx.contentProductionItem.findMany({
        where: { mediaAssetId: id },
        select: { batchId: true },
      });
      for (const batchId of new Set(items.map((item) => item.batchId))) {
        await refreshContentProductionBatchStats(tx, batchId);
      }
    }
    return tx.mediaAsset.findUniqueOrThrow({
      where: { id },
      include: contentAssetInclude,
    });
  });
  await writeAudit(request, actor, {
    action: "content.asset.update",
    targetType: "media_asset",
    targetId: id,
    reason: body.reason,
    before: { metadata: asset.metadata },
    after: { status: body.status ?? null, purpose: body.purpose ?? null, tags: body.tags ?? null },
  });
  return ok({ asset: contentAssetDTO(updated) });
}

export async function bulkPatchContentAssets(request: Request) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = assetBulkSchema.parse(await jsonBody(request));
  if (body.confirmation !== body.assetIds.join(",")) {
    throw Errors.badRequest("Confirmation did not match bulk asset targets");
  }
  const updatedIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const assets = await tx.mediaAsset.findMany({
      where: { id: { in: body.assetIds }, deletedAt: null },
      select: { id: true },
    });
    for (const asset of assets) {
      await patchAssetMetadata(tx, asset.id, {
        status: body.status,
        tags: body.tags,
        description: body.description,
      });
      if (body.tags !== undefined) {
        await tx.contentProductionItem.updateMany({
          where: { mediaAssetId: asset.id },
          data: { tags: toInputJson(body.tags) },
        });
      }
      if (body.status && ["approved", "rejected", "published"].includes(body.status)) {
        await tx.contentProductionItem.updateMany({
          where: { mediaAssetId: asset.id, status: { notIn: ["published"] } },
          data: {
            status: body.status,
            tags: body.tags ? toInputJson(body.tags) : undefined,
            reviewedById: actor.id,
            reviewedAt: new Date(),
          },
        });
      }
      updatedIds.push(asset.id);
    }
    const items = await tx.contentProductionItem.findMany({
      where: { mediaAssetId: { in: updatedIds } },
      select: { batchId: true },
    });
    for (const batchId of new Set(items.map((item) => item.batchId))) {
      await refreshContentProductionBatchStats(tx, batchId);
    }
  });
  await writeAudit(request, actor, {
    action: "content.asset.bulk_update",
    targetType: "media_asset_batch",
    targetId: `${updatedIds.length} assets`,
    reason: body.reason,
    after: { assetIds: updatedIds, status: body.status ?? null, tags: body.tags ?? null },
  });
  return ok({ updatedIds });
}

export async function listPlacements(request: Request) {
  await actorWithPermission(request, "content.asset.read");
  const url = new URL(request.url);
  const status = url.searchParams.get("status")?.trim() || undefined;
  const slot = placementSlotSchema.safeParse(url.searchParams.get("slot")).data;
  const targetId = url.searchParams.get("targetId")?.trim() || undefined;
  const placements = await prisma.mediaAssetPlacement.findMany({
    where: { status, slot, targetId },
    include: placementInclude,
    orderBy: { createdAt: "desc" },
    take: clampInt(url.searchParams.get("limit"), 1, 200, 80),
  });
  return ok({ items: placements.map(placementDTO) });
}

export async function createPlacement(request: Request) {
  const actor = await actorWithPermission(request, "content.placement.write");
  const body = placementCreateSchema.parse(await jsonBody(request));
  await assertApprovedAsset(body.mediaAssetId);
  const scheduledAt = parseOptionalDate(body.scheduledAt);
  validatePlacementTarget(body.slot, body.targetType);
  const placement = await prisma.$transaction(async (tx) => {
    if (body.status === "published") {
      await archiveCurrentPlacement(tx, body.slot, body.targetType, body.targetId);
    }
    const created = await tx.mediaAssetPlacement.create({
      data: {
        mediaAssetId: body.mediaAssetId,
        slot: body.slot,
        targetType: body.targetType,
        targetId: body.targetId,
        status: body.status,
        scheduledAt,
        publishedAt: body.status === "published" ? new Date() : null,
        createdById: actor.id,
        metadata: toInputJson(body.metadata),
      },
    });
    if (created.status === "published") {
      await syncPlacementTarget(tx, created);
      await markPlacementItemPublished(tx, created.mediaAssetId);
    }
    return tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: created.id },
      include: placementInclude,
    });
  });
  await writeAudit(request, actor, {
    action: body.status === "published" ? "content.placement.publish" : "content.placement.create",
    targetType: "media_asset_placement",
    targetId: placement.id,
    reason: body.reason,
    after: {
      mediaAssetId: placement.mediaAssetId,
      slot: placement.slot,
      targetType: placement.targetType,
      targetId: placement.targetId,
      status: placement.status,
    },
  });
  return ok({ placement: placementDTO(placement) });
}

export async function patchPlacement(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.placement.write");
  const body = placementPatchSchema.parse(await jsonBody(request));
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match placement");
  }
  const before = await prisma.mediaAssetPlacement.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Placement not found");
  if (body.status === "published") await assertApprovedAsset(before.mediaAssetId);
  const scheduledAt = parseOptionalDate(body.scheduledAt);
  const placement = await prisma.$transaction(async (tx) => {
    if (body.status === "published") {
      await archiveCurrentPlacement(tx, before.slot, before.targetType, before.targetId, id);
    }
    const updated = await tx.mediaAssetPlacement.update({
      where: { id },
      data: {
        status: body.status,
        scheduledAt: body.scheduledAt === undefined ? undefined : scheduledAt,
        publishedAt: body.status === "published" ? new Date() : undefined,
        pausedAt: body.status === "paused" ? new Date() : undefined,
        archivedAt: body.status === "archived" ? new Date() : undefined,
        metadata: body.metadata ? toInputJson(body.metadata) : undefined,
      },
    });
    if (updated.status === "published") {
      await syncPlacementTarget(tx, updated);
      await markPlacementItemPublished(tx, updated.mediaAssetId);
    }
    return tx.mediaAssetPlacement.findUniqueOrThrow({
      where: { id },
      include: placementInclude,
    });
  });
  await writeAudit(request, actor, {
    action: body.status ? `content.placement.${body.status}` : "content.placement.update",
    targetType: "media_asset_placement",
    targetId: id,
    reason: body.reason,
    before: {
      status: before.status,
      mediaAssetId: before.mediaAssetId,
      slot: before.slot,
      targetId: before.targetId,
    },
    after: {
      status: placement.status,
      mediaAssetId: placement.mediaAssetId,
      slot: placement.slot,
      targetId: placement.targetId,
    },
  });
  return ok({ placement: placementDTO(placement) });
}

async function resolveProductionProfile(profileId: string, version?: number) {
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      version,
      OR: [{ id: profileId }, { profileKey: profileId }],
    },
    orderBy: { version: "desc" },
  });
  if (!profile) throw Errors.badRequest("Production Studio requires an active image profile");
  return profile;
}

async function resolveProductionRecipe(
  recipeId: string | undefined,
  targetType: string,
  version?: number,
) {
  const useCase = targetType === "character" ? "character" : "freeplay";
  const recipe = await prisma.generationPromptTemplate.findFirst({
    where: recipeId
      ? {
          mode: "image",
          status: "active",
          version,
          OR: [{ id: recipeId }, { templateKey: recipeId }],
        }
      : {
          mode: "image",
          status: "active",
          useCase,
        },
    orderBy: { version: "desc" },
  });
  if (!recipe) throw Errors.badRequest("Production Studio requires an active prompt recipe");
  return recipe;
}

async function resolveProductionTarget(targetType: string, targetId?: string) {
  if (targetType === "none" || !targetId) return null;
  if (targetType === "character") {
    const character = await prisma.character.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        name: true,
        age: true,
        gender: true,
        style: true,
        description: true,
      },
    });
    if (!character) throw Errors.badRequest("Target character not found");
    return {
      type: "character",
      id: character.id,
      label: character.name,
      detail: `${character.age}, ${character.gender}, ${character.style}. ${character.description}`,
    };
  }
  if (targetType === "template") {
    const template = await prisma.characterTemplate.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, summary: true, gender: true, style: true },
    });
    if (!template) throw Errors.badRequest("Target template not found");
    return {
      type: "template",
      id: template.id,
      label: template.name,
      detail: [template.summary, template.gender, template.style].filter(Boolean).join(", "),
    };
  }
  return { type: targetType, id: targetId, label: targetId, detail: "" };
}

function productionPrompt(input: {
  purpose: z.infer<typeof productionPurposeSchema>;
  target: Awaited<ReturnType<typeof resolveProductionTarget>>;
  recipeBody: string;
  presetFragment: string;
  brief?: string;
}) {
  return [
    `Production purpose: ${purposeLabel(input.purpose)}.`,
    input.target ? `Target ${input.target.type}: ${input.target.label}. ${input.target.detail}` : "",
    `Recipe: ${input.recipeBody}`,
    input.presetFragment ? `Presets: ${input.presetFragment}` : "",
    input.brief ? `Operator brief: ${input.brief}` : "",
    "Generate a polished, reusable platform image with clear subject framing and no text overlay.",
  ]
    .filter(Boolean)
    .join("\n");
}

function productionControls(input: {
  orientation: string;
  dimensions: { width: number; height: number };
  profile: {
    profileKey: string;
    version: number;
    runner: string;
    pipelineModel: string;
    sourceModelPath: string | null;
    convertedModelPath: string | null;
    modelFormat: string;
    runnerConfig: Prisma.JsonValue | null;
    steps: number;
    sampler: string;
    scheduler: string;
    cfgScale: number;
    defaultWidth: number;
    defaultHeight: number;
  };
  presets: Array<{ id: string; type: string }>;
}) {
  return pruneUndefined({
    orientation: input.orientation,
    model: input.profile.profileKey,
    profileId: input.profile.profileKey,
    width: input.dimensions.width,
    height: input.dimensions.height,
    backgroundPresetId: presetIdForType(input.presets, "background"),
    posePresetId: presetIdForType(input.presets, "pose"),
    outfitPresetId: presetIdForType(input.presets, "outfit"),
    modePresetId: presetIdForType(input.presets, "mode"),
    contentProduction: true,
    sdcpp: input.profile.runner === "sd_cpp" ? sdcppProfileRuntimeConfig(input.profile) : undefined,
  });
}

function presetIdForType(presets: Array<{ id: string; type: string }>, type: string) {
  return presets.find((preset) => preset.type === type)?.id;
}

function presetPromptFragment(
  orderedIds: string[],
  presets: Array<{ id: string; label: string; controls: Prisma.JsonValue }>,
) {
  const fragments: string[] = [];
  for (const id of orderedIds) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) continue;
    const controls = jsonRecord(preset.controls);
    const values = Object.values(controls)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    fragments.push(values.length ? values.join(", ") : preset.label);
  }
  return fragments.join(", ");
}

function sdcppProfileRuntimeConfig(profile: {
  profileKey: string;
  version: number;
  pipelineModel: string;
  sourceModelPath: string | null;
  convertedModelPath: string | null;
  modelFormat: string;
  runnerConfig: Prisma.JsonValue | null;
  steps: number;
  sampler: string;
  scheduler: string;
  cfgScale: number;
  defaultWidth: number;
  defaultHeight: number;
}) {
  const config = jsonRecord(profile.runnerConfig);
  const conversion = jsonRecord(config.conversion);
  return pruneUndefined({
    profileKey: profile.profileKey,
    profileVersion: profile.version,
    apiModelId: profile.pipelineModel,
    modelFormat: profile.modelFormat,
    sourceModelPath: profile.sourceModelPath,
    convertedModelPath: profile.convertedModelPath,
    modelPath: stringFromRecord(config, "modelPath"),
    diffusionModelPath: stringFromRecord(config, "diffusionModelPath"),
    llmPath: stringFromRecord(config, "llmPath"),
    vaePath: stringFromRecord(config, "vaePath"),
    llmVisionPath: stringFromRecord(config, "llmVisionPath"),
    clipLPath: stringFromRecord(config, "clipLPath"),
    clipGPath: stringFromRecord(config, "clipGPath"),
    t5xxlPath: stringFromRecord(config, "t5xxlPath"),
    backend: stringFromRecord(config, "backend"),
    loraModelDir: stringFromRecord(config, "loraModelDir"),
    loraApplyMode: stringFromRecord(config, "loraApplyMode"),
    loras: normalizeSdcppLoras(config.loras),
    conversion:
      conversion.enabled === true
        ? pruneUndefined({
            enabled: true,
            targetFormat: "gguf",
            outputPath: stringFromRecord(conversion, "outputPath") ?? profile.convertedModelPath,
            type: stringFromRecord(conversion, "type") ?? "q8_0",
            sourceArg: stringFromRecord(conversion, "sourceArg") ?? "model",
            convertName: conversion.convertName === true,
            tensorTypeRules: stringFromRecord(conversion, "tensorTypeRules"),
          })
        : undefined,
    steps: profile.steps,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    cfgScale: profile.cfgScale,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
}

function normalizeSdcppLoras(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const loras = value
    .filter(isRecord)
    .map((item) =>
      pruneUndefined({
        key: stringFromRecord(item, "key"),
        path: stringFromRecord(item, "path"),
        weight: typeof item.weight === "number" && Number.isFinite(item.weight) ? item.weight : 1,
        enabled: item.enabled !== false,
      }),
    )
    .filter((item) => typeof item.key === "string" || typeof item.path === "string");
  return loras.length ? loras : undefined;
}

async function itemWithAsset(id: string) {
  const item = await prisma.contentProductionItem.findUnique({
    where: { id },
    include: {
      batch: true,
      job: { include: { assets: { orderBy: { createdAt: "asc" }, take: 1 } } },
      mediaAsset: true,
    },
  });
  if (!item) throw Errors.notFound("Production item not found");
  return item;
}

async function patchAssetMetadata(
  db: Prisma.TransactionClient,
  assetId: string,
  patch: {
    status?: string;
    purpose?: string;
    tags?: string[];
    description?: string;
    reviewNote?: string;
    sourceBatchId?: string;
  },
) {
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw Errors.notFound("Media asset not found");
  const metadata = jsonRecord(asset.metadata);
  const platformAsset = jsonRecord(metadata.platformAsset);
  await db.mediaAsset.update({
    where: { id: assetId },
    data: {
      metadata: toInputJson({
        ...metadata,
        platformAsset: pruneUndefined({
          ...platformAsset,
          status: patch.status ?? platformAsset.status ?? "generated",
          purpose: patch.purpose ?? platformAsset.purpose,
          tags: patch.tags ?? platformAsset.tags ?? [],
          description: patch.description ?? platformAsset.description,
          reviewNote: patch.reviewNote ?? platformAsset.reviewNote,
          sourceBatchId: patch.sourceBatchId ?? platformAsset.sourceBatchId,
          updatedAt: new Date().toISOString(),
        }),
      }),
    },
  });
}

async function assertApprovedAsset(mediaAssetId: string) {
  const approved = await prisma.contentProductionItem.findFirst({
    where: {
      mediaAssetId,
      status: { in: ["approved", "published"] },
    },
    include: { mediaAsset: true },
  });
  if (!approved?.mediaAsset || platformAssetMetadata(approved.mediaAsset).status === "archived") {
    throw Errors.badRequest("Only approved content assets can be placed");
  }
}

async function archiveCurrentPlacement(
  db: Prisma.TransactionClient,
  slot: string,
  targetType: string,
  targetId: string,
  excludeId?: string,
) {
  await db.mediaAssetPlacement.updateMany({
    where: {
      slot,
      targetType,
      targetId,
      status: "published",
      id: excludeId ? { not: excludeId } : undefined,
    },
    data: {
      status: "archived",
      archivedAt: new Date(),
    },
  });
}

async function syncPlacementTarget(
  db: Prisma.TransactionClient,
  placement: { slot: string; targetType: string; targetId: string; mediaAssetId: string },
) {
  if (placement.slot === "character_avatar" || placement.slot === "character_hero") {
    if (placement.targetType !== "character") {
      throw Errors.badRequest("Character image placements require character target type");
    }
    const updated = await db.character.updateMany({
      where: { id: placement.targetId, deletedAt: null },
      data: { imageAssetId: placement.mediaAssetId },
    });
    if (updated.count !== 1) throw Errors.notFound("Placement target character not found");
    return;
  }
  if (placement.slot === "template_cover") {
    if (placement.targetType !== "template") {
      throw Errors.badRequest("Template cover placements require template target type");
    }
    const updated = await db.characterTemplate.updateMany({
      where: { id: placement.targetId },
      data: { coverAssetId: placement.mediaAssetId },
    });
    if (updated.count !== 1) throw Errors.notFound("Placement target template not found");
  }
}

async function markPlacementItemPublished(db: Prisma.TransactionClient, mediaAssetId: string) {
  const items = await db.contentProductionItem.findMany({
    where: { mediaAssetId },
    select: { batchId: true },
  });
  await db.contentProductionItem.updateMany({
    where: { mediaAssetId, status: { in: ["approved", "generated"] } },
    data: { status: "published" },
  });
  await patchAssetMetadata(db, mediaAssetId, { status: "published" });
  for (const batchId of new Set(items.map((item) => item.batchId))) {
    await refreshContentProductionBatchStats(db, batchId);
  }
}

function validatePlacementTarget(slot: string, targetType: string) {
  if ((slot === "character_avatar" || slot === "character_hero") && targetType !== "character") {
    throw Errors.badRequest("Character image placements require character target type");
  }
  if (slot === "template_cover" && targetType !== "template") {
    throw Errors.badRequest("Template cover placements require template target type");
  }
}

async function appendProductionJobEvent(
  tx: Prisma.TransactionClient,
  jobId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown>,
) {
  return tx.generationJobEvent.create({
    data: {
      jobId,
      type,
      message,
      metadata: toInputJson(metadata),
    },
  });
}

export function productionBatchDTO(batch: ProductionBatchWithItems) {
  return {
    id: batch.id,
    title: batch.title,
    purpose: batch.purpose,
    targetType: batch.targetType,
    targetId: batch.targetId,
    profileId: batch.profileId,
    profileVersion: batch.profileVersion,
    recipeId: batch.recipeId,
    recipeVersion: batch.recipeVersion,
    presetIds: jsonStringArray(batch.presetIds),
    orientation: batch.orientation,
    brief: batch.brief,
    count: batch.count,
    totalItems: batch.totalItems,
    completedItems: batch.completedItems,
    failedItems: batch.failedItems,
    approvedItems: batch.approvedItems,
    estimatedCostDreamcoins: batch.estimatedCostDreamcoins,
    status: batch.status,
    createdById: batch.createdById,
    createdByEmail: batch.createdBy.email,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    items: batch.items.map(productionItemDTO),
  };
}

function productionItemDTO(
  item: Prisma.ContentProductionItemGetPayload<{
    include: { batch: true; job: { include: { assets: true } }; mediaAsset: true };
  }> | ProductionBatchWithItems["items"][number],
) {
  const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
  return {
    id: item.id,
    batchId: item.batchId,
    itemIndex: item.itemIndex,
    jobId: item.jobId,
    mediaAssetId: asset?.id ?? item.mediaAssetId,
    status: item.status,
    reviewNote: item.reviewNote,
    rating: item.rating,
    tags: jsonStringArray(item.tags),
    reviewedById: item.reviewedById,
    reviewedAt: item.reviewedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    job: item.job
      ? {
          id: item.job.id,
          status: item.job.status,
          errorCode: item.job.errorCode,
          profileId: item.job.profileId,
          profileVersion: item.job.profileVersion,
          promptTemplateId: item.job.promptTemplateId,
          promptTemplateVersion: item.job.promptTemplateVersion,
          createdAt: item.job.createdAt,
          completedAt: item.job.completedAt,
        }
      : null,
    asset: asset ? mediaAssetDTO(asset) : null,
  };
}

function contentAssetDTO(asset: ContentAssetWithRelations) {
  const item = asset.productionItems[0] ?? null;
  const platform = platformAssetMetadata(asset);
  const platformStatus = platform.status === "archived" ? "archived" : (item?.status ?? platform.status);
  return {
    ...mediaAssetDTO(asset),
    platformStatus: platformStatus ?? "generated",
    purpose: item?.batch.purpose ?? platform.purpose ?? null,
    targetType: item?.batch.targetType ?? null,
    targetId: item?.batch.targetId ?? null,
    tags: item ? jsonStringArray(item.tags) : assetTags(asset),
    description: assetDescription(asset),
    sourceJob: asset.sourceJob
      ? {
          id: asset.sourceJob.id,
          status: asset.sourceJob.status,
          profileId: asset.sourceJob.profileId,
          profileVersion: asset.sourceJob.profileVersion,
          promptTemplateId: asset.sourceJob.promptTemplateId,
          promptTemplateVersion: asset.sourceJob.promptTemplateVersion,
          sourceType: asset.sourceJob.sourceType,
          sourceId: asset.sourceJob.sourceId,
          sourceMeta: asset.sourceJob.sourceMeta,
        }
      : null,
    sourceBatch: item
      ? {
          id: item.batch.id,
          title: item.batch.title,
          purpose: item.batch.purpose,
          status: item.batch.status,
        }
      : null,
    placements: asset.placements.map((placement) => ({
      id: placement.id,
      slot: placement.slot,
      targetType: placement.targetType,
      targetId: placement.targetId,
      status: placement.status,
      publishedAt: placement.publishedAt,
    })),
  };
}

function placementDTO(placement: PlacementWithRelations) {
  return {
    id: placement.id,
    mediaAssetId: placement.mediaAssetId,
    slot: placement.slot,
    targetType: placement.targetType,
    targetId: placement.targetId,
    status: placement.status,
    scheduledAt: placement.scheduledAt,
    publishedAt: placement.publishedAt,
    pausedAt: placement.pausedAt,
    archivedAt: placement.archivedAt,
    createdById: placement.createdById,
    createdByEmail: placement.createdBy.email,
    metadata: placement.metadata,
    createdAt: placement.createdAt,
    updatedAt: placement.updatedAt,
    asset: mediaAssetDTO(placement.mediaAsset),
  };
}

function mediaAssetDTO(asset: {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  safetyStatus: string;
  sourceJobId: string | null;
  prompt: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl ?? asset.url,
    contentType: asset.contentType,
    width: asset.width,
    height: asset.height,
    safetyStatus: asset.safetyStatus,
    sourceJobId: asset.sourceJobId,
    promptSummary: asset.prompt ? asset.prompt.slice(0, 180) : null,
    metadata: asset.metadata,
    createdAt: asset.createdAt,
  };
}

function platformAssetMetadata(asset: { metadata: Prisma.JsonValue }) {
  return jsonRecord(jsonRecord(asset.metadata).platformAsset);
}

function assetTags(asset: { metadata: Prisma.JsonValue }) {
  return jsonStringArray(platformAssetMetadata(asset).tags);
}

function assetDescription(asset: { metadata: Prisma.JsonValue }) {
  const description = platformAssetMetadata(asset).description;
  return typeof description === "string" && description.trim() ? description.trim() : null;
}

function purposeLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseOptionalDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw Errors.badRequest("Invalid scheduledAt value");
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
