import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  isMediaAssetOperationalForAuthority,
  isSyntheticMediaAsset,
} from "@/server/lib/media-asset-authority";
import { toInputJson } from "@/server/lib/request-json";
import { jsonRecord } from "./json-values";

// SPEC: 用户对自己 MediaAsset 的所有权与「能不能拿它当角色身份」的守卫。
//
// INTENT: 建角色、改角色、复制角色、打身份反馈四条路径问的是同一句话
// （这张图归我吗、能不能当身份用），实现必须只有一份。

export async function assertMediaOwner(id: string, userId: string) {
  const media = await prisma.mediaAsset.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
  });
  if (!media) throw Errors.notFound("Media not found");
  return media;
}

export function assertNonSyntheticMediaAsset(
  asset: { id: string; metadata: Prisma.JsonValue },
  message: string,
) {
  if (!isSyntheticMediaAsset(asset.metadata)) return;
  throw Errors.badRequest(message, { mediaAssetId: asset.id });
}

export async function assertIdentityImageMediaInTx(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
) {
  const asset = await tx.mediaAsset.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
  });
  if (!asset) throw Errors.notFound("Media not found");
  if (asset.type !== "image") {
    throw Errors.badRequest("Only image media can update character identity");
  }
  if (asset.safetyStatus !== "passed") {
    throw Errors.conflict("Only safety-passed media can update Character authority");
  }
  if (!isMediaAssetOperationalForAuthority(asset.metadata)) {
    throw Errors.conflict("Archived or rejected media cannot be used for Character authority");
  }
  assertNonSyntheticMediaAsset(
    asset,
    "Synthetic media cannot update character identity",
  );
  return asset;
}

export function mediaMetadataWithQuality(
  metadata: Prisma.JsonValue,
  qualityPatch: Record<string, unknown>,
) {
  const record = jsonRecord(metadata);
  const quality = jsonRecord(record.quality);
  return toInputJson({
    ...record,
    quality: {
      ...quality,
      ...qualityPatch,
    },
  });
}
