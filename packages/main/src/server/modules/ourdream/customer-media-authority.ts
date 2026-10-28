import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  isMediaAssetOperationalForAuthority,
  isSyntheticMediaAsset,
  isUnfinishedExternalImageImport,
} from "@/server/lib/media-asset-authority";
import { toInputJson } from "@/server/lib/request-json";
import { jsonRecord } from "./json-values";

// SPEC: 用户对自己 MediaAsset 的所有权与「能不能拿它当角色身份」的守卫。
//
// INTENT: 建角色、改角色、复制角色、打身份反馈四条路径问的是同一句话
// （这张图归我吗、能不能当身份用），实现必须只有一份。

export async function assertMediaOwner(
  id: string,
  userId: string,
  db: Pick<Prisma.TransactionClient, "mediaAsset"> = prisma,
) {
  const media = await db.mediaAsset.findFirst({
    where: { id, ownerId: userId, deletedAt: null },
  });
  if (!media || isUnfinishedExternalImageImport(media.metadata)) throw Errors.notFound("Media not found");
  return media;
}

export function assertNonSyntheticMediaAsset(
  asset: { id: string; metadata: Prisma.JsonValue },
  message: string,
) {
  if (!isSyntheticMediaAsset(asset.metadata)) return;
  throw Errors.badRequest(message, { mediaAssetId: asset.id });
}

// Preflight and locked commits use the same eligibility rules. A commit must
// pass its transaction and read again after acquiring the media authority lock;
// a successful preflight is not permission to reuse that earlier snapshot.
export async function assertIdentityImageMedia(
  id: string,
  userId: string,
  db: Pick<Prisma.TransactionClient, "mediaAsset"> = prisma,
) {
  const asset = await assertMediaOwner(id, userId, db);
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
