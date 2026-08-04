import type { Prisma } from "@prisma/client";
import {
  contentAssetBulkPreflightRequestSchema,
  contentAssetBulkRequestSchema,
  contentAssetPatchRequestSchema,
  contentAssetQuerySchema,
  contentAssetReviewStatusSchema,
  type ContentAssetBulkPreflightRequest,
  type ContentAssetBulkRequest,
  type ContentAssetPatchRequest,
  type ContentAssetQuery,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { mediaAssetDTO } from "@/server/lib/media-asset-dto";
import {
  resolveMediaAssetAuthorityMap,
  type ResolvedMediaAssetAuthority,
} from "@/server/lib/media-asset-authority-query";
import {
  mediaAssetAuthorityDependencies,
  mediaAssetAuthorityDependenciesBatch,
} from "@/server/modules/admin-v2/shared/media-asset-authority-dependencies";
import { auditedTransaction } from "@/server/modules/admin-v2/shared/audited-transaction";
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  parseIsoCursorKey,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { operationalMediaAssetWhere } from "@/server/modules/metric-data-scope";
import {
  actorWithPermission,
  adminAuditData,
  jsonBody,
  toInputJson,
  type AdminActor,
} from "../shared/legacy-primitives";

// SPEC: Image Library 的 v1 兼容入口与 v2 权威域实现。列表、详情、单条/批量 metadata
// 编辑，以及归档前的依赖预检共享同一组 domain functions。
// INTENT: 这里只管素材的**运营元数据与归档生命周期**。审阅结论（approved/rejected）
// 属于 Creative Run 的不可变决策，所以任何 archived 以外的 status 写入都 fail closed
// 并给出回到 Run 的 repairPath —— 图库不得凭空造出或顶替一次审阅。

type ContentAssetWithRelations = Prisma.MediaAssetGetPayload<{
  include: {
    sourceJob: true;
    productionItems: { include: { batch: true } };
    placements: true;
  };
}>;

type ContentAssetBase = Omit<
  ContentAssetWithRelations,
  "sourceJob" | "productionItems" | "placements"
>;

async function hydrateContentAssets(
  db: Prisma.TransactionClient | typeof prisma,
  assets: readonly ContentAssetBase[],
): Promise<ContentAssetWithRelations[]> {
  if (assets.length === 0) return [];
  const assetIds = assets.map((asset) => asset.id);
  const sourceJobIds = [
    ...new Set(
      assets.flatMap((asset) => asset.sourceJobId ? [asset.sourceJobId] : []),
    ),
  ];
  const jobs = sourceJobIds.length > 0
    ? await db.generationJob.findMany({
        where: { id: { in: sourceJobIds } },
      })
    : [];
  const items = await db.contentProductionItem.findMany({
    where: { mediaAssetId: { in: assetIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const batchIds = [...new Set(items.map((item) => item.batchId))];
  const batches = batchIds.length > 0
    ? await db.contentProductionBatch.findMany({
        where: { id: { in: batchIds } },
      })
    : [];
  const placements = await db.mediaAssetPlacement.findMany({
    where: { mediaAssetId: { in: assetIds } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const jobById = new Map(jobs.map((job) => [job.id, job] as const));
  const batchById = new Map(batches.map((batch) => [batch.id, batch] as const));
  const latestItemByAssetId = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    if (item.mediaAssetId && !latestItemByAssetId.has(item.mediaAssetId)) {
      latestItemByAssetId.set(item.mediaAssetId, item);
    }
  }
  const placementsByAssetId = new Map<string, typeof placements>();
  for (const placement of placements) {
    const existing = placementsByAssetId.get(placement.mediaAssetId) ?? [];
    existing.push(placement);
    placementsByAssetId.set(placement.mediaAssetId, existing);
  }

  return assets.map((asset) => {
    const item = latestItemByAssetId.get(asset.id);
    const batch = item ? batchById.get(item.batchId) : null;
    return {
      ...asset,
      sourceJob: asset.sourceJobId
        ? jobById.get(asset.sourceJobId) ?? null
        : null,
      productionItems: item && batch ? [{ ...item, batch }] : [],
      placements: placementsByAssetId.get(asset.id) ?? [],
    };
  });
}

export async function listContentAssets(request: Request) {
  await actorWithPermission(request, "creative.asset.read");
  const query = contentAssetQuerySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  return ok(await listContentAssetsData(query));
}

export async function listContentAssetsV2(query: ContentAssetQuery) {
  return listContentAssetsData(query);
}

async function listContentAssetsData(query: ContentAssetQuery) {
  const { status, purpose, profileId, targetId, tag, limit } = query;
  const search = query.search?.toLowerCase();
  const productionItemStatus = status === "archived" ? undefined : status;
  const queryIdentity = { status, purpose, profileId, targetId, tag, search, sort: "created_desc" };
  const cursorKeys = query.cursor
    ? decodeAdminListCursor(query.cursor, "content_assets", queryIdentity)
    : null;
  const [cursorAt, cursorId] = cursorKeys
    ? [parseIsoCursorKey(cursorKeys[0], "content_assets"), requiredCursorId(cursorKeys[1])]
    : [null, null];
  const productionAssetScope: Prisma.MediaAssetWhereInput = {
    productionItems: { some: { status: productionItemStatus, batch: { purpose, targetId } } },
  };
  const standalonePlatformAssetScope: Prisma.MediaAssetWhereInput | null = targetId
    ? null
    : {
        productionItems: { none: {} },
        AND: [
          {
            OR: (status ? [status] : contentAssetReviewStatusSchema.options).map((platformStatus) => ({
              metadata: {
                path: ["platformAsset", "status"],
                equals: platformStatus,
              },
            })),
          },
          ...(purpose
            ? [{
                metadata: {
                  path: ["platformAsset", "purpose"],
                  equals: purpose,
                },
              }]
            : []),
        ],
      };
  const assetAuthorityScopes = [
    productionAssetScope,
    ...(standalonePlatformAssetScope ? [standalonePlatformAssetScope] : []),
  ];
  const matches: ContentAssetWithRelations[] = [];
  const batchSize = 100;
  let scanAt = cursorAt;
  let scanId = cursorId;
  let exhausted = false;
  while (matches.length <= limit && !exhausted) {
    const baseAssets = await prisma.mediaAsset.findMany({
      where: operationalMediaAssetWhere({
        type: "image",
        deletedAt: null,
        sourceJob: profileId ? { profileId } : undefined,
        AND: [
          { OR: assetAuthorityScopes },
          ...(scanAt && scanId
            ? [{ OR: [{ createdAt: { lt: scanAt } }, { createdAt: scanAt, id: { lt: scanId } }] }]
            : []),
        ],
      }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: batchSize,
    });
    if (baseAssets.length === 0) {
      exhausted = true;
      break;
    }
    const assets = await hydrateContentAssets(prisma, baseAssets);
    for (const asset of assets) {
      const metadata = platformAssetMetadata(asset);
      const tags = assetTags(asset);
      if (status === "archived" && metadata.status !== "archived") continue;
      if (status && status !== "archived" && metadata.status === "archived") continue;
      if (tag && !tags.includes(tag)) continue;
      if (search) {
        const dto = contentAssetDTO(asset);
        const haystack = [dto.id, dto.description ?? "", dto.purpose ?? "", dto.targetId ?? "", ...dto.tags].join(" ").toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      matches.push(asset);
    }
    const last = baseAssets.at(-1)!;
    scanAt = last.createdAt;
    scanId = last.id;
    exhausted = assets.length < batchSize;
  }
  const page = matches.slice(0, limit);
  const hasNextPage = matches.length > limit || !exhausted;
  const last = page.at(-1);
  const mediaAuthorityById = await resolveMediaAssetAuthorityMap(prisma, page);
  return {
    items: page.map((asset) =>
      contentAssetDTO(asset, mediaAuthorityById.get(asset.id)),
    ),
    pageInfo: {
      endCursor: hasNextPage && last
        ? encodeAdminListCursor("content_assets", queryIdentity, [last.createdAt.toISOString(), last.id])
        : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  };
}

function requiredCursorId(value: unknown) {
  if (typeof value !== "string" || !value) {
    throw Errors.badRequest("Invalid content assets cursor");
  }
  return value;
}

async function assertAssetLibraryMutationAllowed(
  db: Prisma.TransactionClient,
  assetId: string,
  status: ContentAssetPatchRequest["status"],
) {
  if (status && status !== "archived") {
    const item = await db.contentProductionItem.findUnique({
      where: { mediaAssetId: assetId },
      select: { batchId: true },
    });
    throw Errors.conflict(
      "Image Library cannot create or replace Creative review authority",
      {
        code: "creative_run_review_required",
        repairPath: item ? `/admin/creative/runs/${item.batchId}` : "/admin/creative/runs",
      },
    );
  }
  if (status !== "archived") return;
  const dependencies = await mediaAssetAuthorityDependencies(db, assetId);
  if (dependencies.length > 0) {
    throw Errors.conflict(
      "A live or staged authority must be rolled back or replaced before this asset can be archived",
      {
        code: "asset_authority_dependency_active",
        assetId,
        dependencies,
        repairPath: dependencies[0]?.repairPath ?? "/admin/creative/runs",
      },
    );
  }
}

async function assertAssetLibraryMutationsAllowed(
  db: Prisma.TransactionClient,
  assetIds: readonly string[],
  status: ContentAssetBulkRequest["status"],
) {
  if (status && status !== "archived") {
    const item = await db.contentProductionItem.findFirst({
      where: { mediaAssetId: { in: [...assetIds] } },
      select: { mediaAssetId: true, batchId: true },
    });
    throw Errors.conflict(
      "Image Library cannot create or replace Creative review authority",
      {
        code: "creative_run_review_required",
        assetId: item?.mediaAssetId ?? assetIds[0],
        repairPath: item ? `/admin/creative/runs/${item.batchId}` : "/admin/creative/runs",
      },
    );
  }
  if (status !== "archived") return;
  const dependenciesByAssetId = await mediaAssetAuthorityDependenciesBatch(
    db,
    assetIds,
  );
  for (const assetId of assetIds) {
    const dependencies = dependenciesByAssetId.get(assetId) ?? [];
    if (dependencies.length === 0) continue;
    throw Errors.conflict(
      "A live or staged authority must be rolled back or replaced before this asset can be archived",
      {
        code: "asset_authority_dependency_active",
        assetId,
        dependencies,
        repairPath: dependencies[0]?.repairPath ?? "/admin/creative/runs",
      },
    );
  }
}

function missingOrDeletedAssetIds(
  requestedAssetIds: readonly string[],
  assets: readonly { id: string; deletedAt: Date | null }[],
) {
  const availableAssetIds = new Set(
    assets
      .filter((asset) => asset.deletedAt === null)
      .map((asset) => asset.id),
  );
  return requestedAssetIds.filter((assetId) => !availableAssetIds.has(assetId));
}

export async function getContentAsset(request: Request, id: string) {
  await actorWithPermission(request, "creative.asset.read");
  return ok(await getContentAssetV2(id));
}

export async function getContentAssetV2(id: string) {
  const baseAsset = await prisma.mediaAsset.findFirst({
    where: operationalMediaAssetWhere({ id, deletedAt: null }),
  });
  if (!baseAsset) throw Errors.notFound("Content asset not found");
  const [asset] = await hydrateContentAssets(prisma, [baseAsset]);
  if (!asset) throw Errors.notFound("Content asset not found");
  const authority = (
    await resolveMediaAssetAuthorityMap(prisma, [asset])
  ).get(asset.id);
  return {
    asset: {
      ...contentAssetDTO(asset, authority),
      authorityDependencies: await mediaAssetAuthorityDependencies(prisma, id),
    },
  };
}

export async function patchContentAsset(request: Request, id: string) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = contentAssetPatchRequestSchema.parse(await jsonBody(request));
  const result = await auditedTransaction("content.asset.update", (tx) =>
    patchContentAssetV2({ request, id, actor, body, tx })
  );
  return ok(result);
}

export async function patchContentAssetV2(input: {
  request: Request;
  id: string;
  actor: AdminActor;
  body: ContentAssetPatchRequest;
  tx: Prisma.TransactionClient;
  requestId?: string;
}) {
  const { request, id, actor, body, tx, requestId } = input;
  if (body.confirmation !== id) {
    throw Errors.badRequest("Confirmation did not match asset");
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${id}`}))`;
  const asset = await tx.mediaAsset.findFirst({
    where: operationalMediaAssetWhere({ id, deletedAt: null }),
  });
  if (!asset) throw Errors.notFound("Content asset not found");
  await assertAssetLibraryMutationAllowed(tx, id, body.status);
  await patchAssetMetadata(tx, id, {
    status: body.status,
    // Archival is a lifecycle-only action. Never replay metadata from an
    // operator's stale detail-page draft over a newer curator write.
    tags: body.status === "archived" ? undefined : body.tags,
    description: body.status === "archived" ? undefined : body.description,
  });
  const nextBase = await tx.mediaAsset.findUniqueOrThrow({ where: { id } });
  const [updated] = await hydrateContentAssets(tx, [nextBase]);
  if (!updated) throw Errors.notFound("Content asset not found");
  await tx.adminAuditLog.create({
    data: {
      ...adminAuditData(request, actor, {
        action: "content.asset.update",
        targetType: "media_asset",
        targetId: id,
        reason: body.reason,
        before: { metadata: asset.metadata },
        after: {
          status: body.status ?? null,
          tags: body.status === "archived" ? null : body.tags ?? null,
        },
      }),
      ...(requestId ? { requestId } : {}),
    },
  });
  const authority = (
    await resolveMediaAssetAuthorityMap(tx, [updated])
  ).get(updated.id);
  return { asset: contentAssetDTO(updated, authority) };
}

export async function preflightContentAssetArchive(request: Request) {
  await actorWithPermission(request, "content.asset.review");
  const body = contentAssetBulkPreflightRequestSchema.parse(await jsonBody(request));
  return ok(await preflightContentAssetArchiveV2(body));
}

export async function preflightContentAssetArchiveV2(
  body: ContentAssetBulkPreflightRequest,
) {
  const requestedAssetIds = [...new Set(body.assetIds)].sort();
  const assets = await prisma.mediaAsset.findMany({
    where: operationalMediaAssetWhere({
      id: { in: requestedAssetIds },
    }),
    select: { id: true, deletedAt: true },
  });
  const missingAssetIds = missingOrDeletedAssetIds(requestedAssetIds, assets);
  if (missingAssetIds.length > 0) {
    throw Errors.notFound("One or more content assets were not found", {
      missingAssetIds,
    });
  }
  const dependenciesByAssetId = await mediaAssetAuthorityDependenciesBatch(
    prisma,
    requestedAssetIds,
  );
  return {
    assetIds: requestedAssetIds,
    blockers: requestedAssetIds.flatMap((assetId) => {
      const dependencies = dependenciesByAssetId.get(assetId) ?? [];
      return dependencies.length > 0 ? [{ assetId, dependencies }] : [];
    }),
  };
}

export async function bulkPatchContentAssets(request: Request) {
  const actor = await actorWithPermission(request, "content.asset.review");
  const body = contentAssetBulkRequestSchema.parse(await jsonBody(request));
  const result = await auditedTransaction("content.asset.bulk_update", (tx) =>
    bulkPatchContentAssetsV2({ request, actor, body, tx })
  );
  return ok(result);
}

export async function bulkPatchContentAssetsV2(input: {
  request: Request;
  actor: AdminActor;
  body: ContentAssetBulkRequest;
  tx: Prisma.TransactionClient;
  requestId?: string;
}) {
  const { request, actor, body, tx, requestId } = input;
  const requestedAssetIds = [...new Set(body.assetIds)].sort();
  const canonicalTargets = requestedAssetIds.length === body.assetIds.length
    && requestedAssetIds.every((assetId, index) => assetId === body.assetIds[index]);
  if (!canonicalTargets) {
    throw Errors.badRequest("Bulk asset targets must be sorted and unique", {
      expectedAssetIds: requestedAssetIds,
    });
  }
  if (body.confirmation !== requestedAssetIds.join(",")) {
    throw Errors.badRequest("Confirmation did not match bulk asset targets");
  }
  for (const assetId of requestedAssetIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${assetId}`}))`;
  }
  // The row snapshot is intentionally loaded only after every authority
  // lock is held. A concurrent customer delete/private mutation can finish
  // before the locks are acquired, but can no longer turn this into a
  // partial or misleading success.
  const assets = await tx.mediaAsset.findMany({
    where: operationalMediaAssetWhere({ id: { in: requestedAssetIds } }),
    select: { id: true, deletedAt: true, metadata: true },
  });
  const missingAssetIds = missingOrDeletedAssetIds(requestedAssetIds, assets);
  if (assets.length !== requestedAssetIds.length || missingAssetIds.length > 0) {
    throw Errors.notFound("One or more content assets were not found", {
      missingAssetIds,
    });
  }
  await assertAssetLibraryMutationsAllowed(tx, requestedAssetIds, body.status);
  for (const asset of assets) {
    await patchAssetMetadata(tx, asset.id, {
      status: body.status,
      tags: body.status === "archived" ? undefined : body.tags,
      description: body.status === "archived" ? undefined : body.description,
    });
  }
  const updatedIds = [...requestedAssetIds];
  await tx.adminAuditLog.create({
    data: {
      ...adminAuditData(request, actor, {
        action: "content.asset.bulk_update",
        targetType: "media_asset_batch",
        targetId: `${updatedIds.length} assets`,
        reason: body.reason,
        after: {
          assetIds: updatedIds,
          status: body.status ?? null,
          tags: body.tags ?? null,
        },
      }),
      ...(requestId ? { requestId } : {}),
    },
  });
  return { updatedIds };
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
          tags: patch.tags ?? platformAsset.tags,
          description: patch.description ?? platformAsset.description,
          reviewNote: patch.reviewNote ?? platformAsset.reviewNote,
          sourceBatchId: patch.sourceBatchId ?? platformAsset.sourceBatchId,
          updatedAt: new Date().toISOString(),
        }),
      }),
    },
  });
}

function contentAssetDTO(
  asset: ContentAssetWithRelations,
  authority?: ResolvedMediaAssetAuthority,
) {
  const item = asset.productionItems[0] ?? null;
  const platform = platformAssetMetadata(asset);
  const platformHasTags = Object.hasOwn(platform, "tags");
  const platformStatus = platform.status === "archived" ? "archived" : (item?.status ?? platform.status);
  return {
    ...mediaAssetDTO(asset, authority),
    createdAt: asset.createdAt.toISOString(),
    platformStatus: platformStatus ?? "generated",
    purpose: item?.batch.purpose ?? platform.purpose ?? null,
    targetType: item?.batch.targetType ?? null,
    targetId: item?.batch.targetId ?? null,
    tags: platformHasTags ? assetTags(asset) : item ? jsonStringArray(item.tags) : [],
    description: assetDescription(asset),
    sourceJob: asset.sourceJob
      ? {
          id: asset.sourceJob.id,
          status: asset.sourceJob.status,
          profileId: asset.sourceJob.profileId,
          profileVersion: asset.sourceJob.profileVersion,
          recipeId: asset.sourceJob.recipeId,
          recipeVersion: asset.sourceJob.recipeVersion,
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
      publishedAt: placement.publishedAt?.toISOString() ?? null,
    })),
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

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
