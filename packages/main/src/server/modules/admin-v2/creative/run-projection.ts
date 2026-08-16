import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { mediaAssetDTO } from "@/server/lib/media-asset-dto";
import {
  resolveMediaAssetAuthorityMap,
  type ResolvedMediaAssetAuthority,
} from "@/server/lib/media-asset-authority-query";
import {
  deriveCreativeRunState,
  type CreativeRunLedgerFact,
} from "@/server/modules/content-production-state";

// SPEC: 一个 Creative Run（ContentProductionBatch 行 + items）对外的读投影。
// INTENT: Creative Run 的创建路径与只读投影
// 必须给出同一个 Run 形状。此前两者共用一个大杂烩文件里的私有 DTO，拆开后如果各留一份
// 就会漂移，所以投影单独成模块，两边只 import。
// INVARIANT: 结算事实（ledger）只在读路径装载 —— 创建/重放响应不代表任何扣费结论。

export const creativeRunInclude = {
  createdBy: { select: { id: true, email: true, displayName: true, name: true } },
  items: {
    include: {
      job: { include: { assets: true } },
      mediaAsset: true,
    },
    orderBy: { itemIndex: "asc" },
  },
} satisfies Prisma.ContentProductionBatchInclude;

export type CreativeRunWithItems = Prisma.ContentProductionBatchGetPayload<{
  include: typeof creativeRunInclude;
}>;

/** 读路径：一并装载结算事实与素材可发布性权威。 */
export async function creativeRunDTOs(
  batches: readonly CreativeRunWithItems[],
) {
  const [ledgerEntries, mediaAuthorityById] = await Promise.all([
    creativeRunLedgerFacts(batches),
    creativeRunMediaAuthority(batches),
  ]);
  return batches.map((batch) =>
    creativeRunDTO(
      batch,
      ledgerFactsForRun(batch, ledgerEntries),
      mediaAuthorityById,
    ),
  );
}

/**
 * 创建 / 幂等重放路径：Run 刚落库（或被重放），这次响应不承载结算结论，
 * 因此只装载素材可发布性权威。
 */
export async function creativeRunCreationDTO(batch: CreativeRunWithItems) {
  const mediaAuthorityById = await creativeRunMediaAuthority([batch]);
  return creativeRunDTO(batch, [], mediaAuthorityById);
}

function creativeRunDTO(
  batch: CreativeRunWithItems,
  ledgerEntries: ReadonlyArray<CreativeRunLedgerFact>,
  mediaAuthorityById: ReadonlyMap<string, ResolvedMediaAssetAuthority>,
) {
  const state = deriveCreativeRunState({
    legacyStatus: batch.status,
    expectedItemCount: batch.totalItems,
    items: batch.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job
          ? {
              id: item.job.id,
              status: item.job.status,
              errorCode: item.job.errorCode,
              costDreamcoins: item.job.costDreamcoins,
            }
          : null,
        asset: asset
          ? {
              id: asset.id,
              safetyStatus: asset.safetyStatus,
              deletedAt: asset.deletedAt,
            }
          : null,
        placements: item.status === "published"
          ? [{ status: "published", verificationState: "pending" as const }]
          : [],
      };
    }),
    ledgerEntries,
  });
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
    consistencyMode: batch.items[0]?.job?.consistencyMode ?? null,
    status: batch.status,
    state,
    createdById: batch.createdById,
    createdByEmail: batch.createdBy.email,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    items: batch.items.map((item) =>
      creativeRunItemDTO(item, mediaAuthorityById),
    ),
  };
}

async function creativeRunMediaAuthority(
  batches: ReadonlyArray<CreativeRunWithItems>,
) {
  const assets = [
    ...new Map(
      batches.flatMap((batch) =>
        batch.items.flatMap((item) => {
          const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
          return asset ? [[asset.id, asset] as const] : [];
        }),
      ),
    ).values(),
  ];
  return resolveMediaAssetAuthorityMap(prisma, assets);
}

async function creativeRunLedgerFacts(
  batches: ReadonlyArray<CreativeRunWithItems>,
): Promise<CreativeRunLedgerFact[]> {
  const jobIds = batches.flatMap((batch) =>
    batch.items.flatMap((item) => (item.jobId ? [item.jobId] : [])),
  );
  if (jobIds.length === 0) return [];
  return prisma.dreamcoinLedger.findMany({
    where: { sourceId: { in: jobIds }, reason: { in: ["generation_spend", "refund"] } },
    select: { sourceId: true, reason: true, delta: true },
  });
}

function ledgerFactsForRun(
  batch: CreativeRunWithItems,
  ledgerEntries: ReadonlyArray<CreativeRunLedgerFact>,
) {
  const jobIds = new Set(
    batch.items.flatMap((item) => (item.jobId ? [item.jobId] : [])),
  );
  return ledgerEntries.filter((entry) => entry.sourceId && jobIds.has(entry.sourceId));
}

function creativeRunItemDTO(
  item: CreativeRunWithItems["items"][number],
  mediaAuthorityById: ReadonlyMap<string, ResolvedMediaAssetAuthority>,
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
          recipeId: item.job.recipeId,
          recipeVersion: item.job.recipeVersion,
          consistencyMode: item.job.consistencyMode,
          createdAt: item.job.createdAt,
          completedAt: item.job.completedAt,
        }
      : null,
    asset: asset
      ? mediaAssetDTO(asset, mediaAuthorityById.get(asset.id))
      : null,
  };
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
