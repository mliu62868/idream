import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  isMediaAssetOperationalForAuthority,
  resolveMediaAssetBlobLocator,
  SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
} from "@/server/lib/media-asset-authority";
import { cryptoRandomId } from "@/server/lib/random-id";
import { toInputJson } from "@/server/lib/request-json";
import {
  lockCharacterGenerationAuthority,
  lockMediaAssetAuthority,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { jsonRecord } from "./json-values";
import { mediaViewUrl } from "./public-read-model";
import { assertNonSyntheticMediaAsset } from "./customer-media-authority";
import {
  compileUserSoulOrBadRequest,
  loadCurrentCharacterContentSnapshot,
  materializeUserCharacterContentVersion,
} from "./character-soul";

// SPEC: 用户把**自己创建的** Character 复制成新的私有副本。
// INTENT: 不允许复制他人（含公开 / unlisted / 官方）角色：副本会带走完整 Soul 与
// advancedDetails，且公开面没有署名，违背 PRD PF-13「Remix 保留作者与来源」。
// 前台入口也只在 Created 里出现；以后做 Remix 另建带署名的路径。
//
// INVARIANT: 副本的身份图是**新的一行 MediaAsset**，只共享底层 blob（shared_immutable
// locator）。基础自动检查属于同一份不可变 bytes，可继承 passed；拥有权、可见性和
// 平台投放信息属于各自的资产行，不能随 blob 跨 owner 继承。

export async function duplicateCharacterForUser(input: {
  readonly userId: string;
  readonly characterId: string;
}) {
  const { characterId: id, userId } = input;
  return prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    const source = await tx.character.findFirst({
      where: { id, deletedAt: null, creatorId: userId },
    });
    if (!source) throw Errors.notFound("Character not found");

    const sourceImageAssetId = source.imageAssetId;
    if (sourceImageAssetId) {
      await lockMediaAssetAuthority(tx, sourceImageAssetId);
    }

    // The Character authority lock stabilizes its primary-image pointer while
    // the canonical MediaAsset authority lock serializes us with archive/delete.
    // Re-read both only after those locks: the discovery read is never authority.
    const lockedSource = await tx.character.findUnique({ where: { id } });
    if (!lockedSource || lockedSource.deletedAt !== null) {
      throw Errors.notFound("Character not found");
    }
    if (lockedSource.imageAssetId !== sourceImageAssetId) {
      throw Errors.conflict("Character image changed while the duplicate was being created");
    }

    const sourceImageAsset = sourceImageAssetId
      ? await tx.mediaAsset.findFirst({
          where: {
            id: sourceImageAssetId,
            deletedAt: null,
            type: "image",
          },
        })
      : null;
    if (
      sourceImageAssetId &&
      (
        !sourceImageAsset ||
        sourceImageAsset.safetyStatus !== "passed" ||
        !sourceImageAsset.url.trim() ||
        !isMediaAssetOperationalForAuthority(sourceImageAsset.metadata)
      )
    ) {
      throw Errors.conflict("The source Character image is no longer available");
    }
    if (sourceImageAsset) {
      assertNonSyntheticMediaAsset(
        sourceImageAsset,
        "Synthetic media cannot be copied as a character identity",
      );
    }

    const name = `${lockedSource.name} Copy`;
    const immutableContentSnapshot = await loadCurrentCharacterContentSnapshot(
      tx,
      lockedSource.id,
      lockedSource.currentContentVersionId,
    );
    const userContent = compileUserSoulOrBadRequest({
      name,
      age: lockedSource.age,
      description: lockedSource.description,
      style: lockedSource.style,
      gender: lockedSource.gender,
      appearance: lockedSource.appearance,
      advancedDetails: lockedSource.advancedDetails,
      immutableContentSnapshot,
      immutableSoulOverrides: { name },
    });
    const created = await tx.character.create({
      data: {
        creatorId: userId,
        name,
        age: lockedSource.age,
        description: lockedSource.description,
        systemPrompt: userContent.personaSnapshot.compiled.systemPrompt,
        visibility: "private",
        status: "approved",
        style: lockedSource.style,
        gender: lockedSource.gender,
        imageAssetId: null,
        appearance: toInputJson(lockedSource.appearance ?? {}),
        advancedDetails: toInputJson(lockedSource.advancedDetails ?? {}),
      },
    });
    const contentVersion = await materializeUserCharacterContentVersion({
      tx,
      characterId: created.id,
      sourceId: lockedSource.id,
      createdById: userId,
      content: userContent,
    });
    await tx.character.update({
      where: { id: created.id },
      data: { currentContentVersionId: contentVersion.id },
    });

    const sourceBlobLocator = sourceImageAsset
      ? resolveMediaAssetBlobLocator(sourceImageAsset)
      : null;
    if (sourceImageAsset && sourceBlobLocator) {
      const duplicateImageAssetId = `media_${cryptoRandomId("character_duplicate")}`;
      const sourceMetadata = jsonRecord(sourceImageAsset.metadata);
      const backingKey = sourceBlobLocator.key;
      const duplicateRouteUrl = mediaViewUrl({
        id: duplicateImageAssetId,
        type: sourceImageAsset.type,
        contentType: sourceImageAsset.contentType,
        storageKey: null,
        url: sourceImageAsset.url,
      });
      const duplicateUrl = duplicateRouteUrl;
      const duplicateThumbnailUrl = duplicateRouteUrl;
      const retainedTechnicalMetadata: Record<string, unknown> = {};
      for (const key of [
        "backend",
        "consistencyMode",
        "contentType",
        "height",
        "index",
        "model",
        "profileId",
        "profileVersion",
        "provider",
        "recipeId",
        "recipeVersion",
        "referenceAssetIds",
        "seconds",
        "seed",
        "usage",
        "visualProfileId",
        "visualProfileVersion",
        "width",
        "workflow",
      ]) {
        if (Object.hasOwn(sourceMetadata, key)) {
          retainedTechnicalMetadata[key] = sourceMetadata[key];
        }
      }
      await tx.mediaAsset.create({
        data: {
          id: duplicateImageAssetId,
          ownerId: userId,
          characterId: created.id,
          type: "image",
          url: duplicateUrl,
          thumbnailUrl: duplicateThumbnailUrl,
          storageKey: null,
          contentType: sourceImageAsset.contentType,
          width: sourceImageAsset.width,
          height: sourceImageAsset.height,
          providerAssetId: sourceImageAsset.providerAssetId,
          sourcePromptHash: sourceImageAsset.sourcePromptHash,
          prompt: sourceImageAsset.prompt,
          visibility: "private",
          // The locked source was verified passed above, and no bytes change.
          // Keep that automated result without creating a manual review record.
          safetyStatus: sourceImageAsset.safetyStatus,
          metadata: toInputJson({
            ...retainedTechnicalMetadata,
            source: "character_duplicate",
            synthetic: false,
            providerKey: backingKey,
            blobLocator: {
              schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA,
              kind: "shared_immutable",
              key: backingKey,
              sourceAssetId: sourceImageAsset.id,
            },
            duplicateLineage: {
              schemaVersion: 1,
              sourceAssetId: sourceImageAsset.id,
              sourceCharacterId: lockedSource.id,
              sourceOwnerId: sourceImageAsset.ownerId,
              duplicateCharacterId: created.id,
              duplicatedByUserId: userId,
            },
          }),
        },
      });
      await tx.character.update({
        where: { id: created.id },
        data: { imageAssetId: duplicateImageAssetId },
      });
    }

    await tx.characterStats.create({ data: { characterId: created.id } });
    return tx.character.findUniqueOrThrow({ where: { id: created.id } });
  });
}
