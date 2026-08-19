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
import { publicCharacterAudienceWhere } from "./public-content-audience";
import { mediaViewUrl } from "./public-read-model";
import { assertNonSyntheticMediaAsset } from "./customer-media-authority";
import {
  compileUserSoulOrBadRequest,
  loadCurrentCharacterContentSnapshot,
  materializeUserCharacterContentVersion,
} from "./character-soul";

// SPEC: 用户把一个可见的 Character 复制成自己的私有副本。
//
// INVARIANT: 副本的身份图是**新的一行 MediaAsset**，只共享底层 blob（shared_immutable
// locator），safetyStatus 重置为 unknown —— 复用源行的 `passed` 等于把审核权威跨 owner
// 洗白。副本自身必须重新挣得审核结论。

export async function duplicateCharacterForUser(input: {
  readonly userId: string;
  readonly characterId: string;
}) {
  const { characterId: id, userId } = input;
  return prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    const source = await tx.character.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [
          publicCharacterAudienceWhere,
          { creatorId: userId },
        ],
      },
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
      relationship: lockedSource.relationship,
      style: lockedSource.style,
      gender: lockedSource.gender,
      appearance: lockedSource.appearance,
      advancedDetails: lockedSource.advancedDetails,
      immutableContentSnapshot,
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
        relationship: lockedSource.relationship,
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
          // A distinct asset must earn its own review decision. Reusing the
          // source row's `passed`/platform approval would launder authority
          // across owners even though the underlying bytes are shared.
          safetyStatus: "unknown",
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
