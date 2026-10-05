import { createHash } from "node:crypto";
import { fishAudioDeliverySettingsSchema } from "@idream/shared/contracts";
import type { Character, MediaAsset, Prisma } from "@prisma/client";
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
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { jsonRecord } from "./json-values";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { createActiveCharacterVisualProfileVersion, createReferenceSetRevision, loadLockedGenerationReferenceAuthority } from "./generation-reference-set";
import { mediaViewUrl } from "./public-read-model";
import { assertNonSyntheticMediaAsset } from "./customer-media-authority";
import {
  compileUserSoulOrBadRequest,
  loadCurrentCharacterContentSnapshot,
  materializeUserCharacterContentVersion,
} from "./character-soul";
import {
  bindCharacterDraftVoice,
  cleanupPreparedCharacterDraftVoice,
  prepareCharacterVoiceCopy,
} from "./character-draft-voice";

function assertDuplicateIdentityImage(asset: MediaAsset | null, imageAssetId: string | null, source: { id: string; creatorId: string | null }) {
  if (imageAssetId && (!asset || asset.safetyStatus !== "passed" || !asset.url.trim() ||
      asset.ownerId !== source.creatorId || (asset.characterId !== null && asset.characterId !== source.id) ||
      !isMediaAssetOperationalForAuthority(asset.metadata) || !resolveMediaAssetBlobLocator(asset))) {
    throw Errors.conflict("The source Character image is no longer available");
  }
  if (asset) assertNonSyntheticMediaAsset(asset, "Synthetic media cannot be copied as a character identity");
}

async function duplicateVisualAuthority(tx: Prisma.TransactionClient, source: Character) {
  await lockCharacterGenerationAuthority(tx, source.id);
  const profile = await tx.characterVisualProfile.findFirst({
    where: { characterId: source.id, status: "active" }, orderBy: { version: "desc" },
  });
  if (profile && (!profile.immutableHash || profile.immutableHash !== characterVisualProfileSnapshotHash(profile))) {
    throw Errors.conflict("The source Character visual identity is not sealed");
  }
  const references = profile
    ? await loadLockedGenerationReferenceAuthority(tx, source.id, profile, "balanced", source.imageAssetId ? [source.imageAssetId] : [])
    : null;
  const assetIds = [...new Set([...(source.imageAssetId ? [source.imageAssetId] : []), ...(references?.referenceAssetIds ?? [])])].sort();
  await lockCharacterMediaAssetAuthorities(tx, assetIds);
  const assets = await tx.mediaAsset.findMany({ where: { id: { in: assetIds }, deletedAt: null, type: "image" }, orderBy: { id: "asc" } });
  for (const id of assetIds) assertDuplicateIdentityImage(assets.find(asset => asset.id === id) ?? null, id, source);
  const value = { profile, references: references?.referenceSetRevision?.references ?? [], assets };
  return { ...value, digest: createHash("sha256").update(JSON.stringify({
    ...value, character: {
      name: source.name, age: source.age, description: source.description, style: source.style, gender: source.gender,
      appearance: source.appearance, advancedDetails: source.advancedDetails, imageAssetId: source.imageAssetId,
      currentContentVersionId: source.currentContentVersionId,
    },
  })).digest("hex") };
}

async function cloneIdentityImage(tx: Prisma.TransactionClient, source: Character, asset: MediaAsset, copy: Character, userId: string) {
  const locator = resolveMediaAssetBlobLocator(asset);
  if (!locator) throw Errors.conflict("The source Character image is no longer available");
  const id = `media_${cryptoRandomId("character_duplicate")}`;
  const url = mediaViewUrl({ id, type: asset.type, contentType: asset.contentType, storageKey: null, url: asset.url });
  const sourceMetadata = jsonRecord(asset.metadata);
  const metadata: Record<string, unknown> = {};
  for (const key of ["backend", "consistencyMode", "contentType", "height", "index", "model", "profileId", "profileVersion",
    "provider", "recipeId", "recipeVersion", "seconds", "seed", "usage", "width", "workflow"]) {
    if (Object.hasOwn(sourceMetadata, key)) metadata[key] = sourceMetadata[key];
  }
  return tx.mediaAsset.create({ data: {
    id, ownerId: userId, characterId: copy.id, type: "image", url, thumbnailUrl: url, storageKey: null,
    contentType: asset.contentType, width: asset.width, height: asset.height, providerAssetId: asset.providerAssetId,
    sourcePromptHash: asset.sourcePromptHash, prompt: asset.prompt, visibility: "private", safetyStatus: asset.safetyStatus,
    metadata: toInputJson({ ...metadata, source: "character_duplicate", synthetic: false, providerKey: locator.key,
      blobLocator: { schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA, kind: "shared_immutable", key: locator.key, sourceAssetId: asset.id },
      duplicateLineage: { schemaVersion: 1, sourceAssetId: asset.id, sourceCharacterId: source.id, sourceOwnerId: asset.ownerId,
        duplicateCharacterId: copy.id, duplicatedByUserId: userId },
    }),
  } });
}

async function bindDuplicateVisual(tx: Prisma.TransactionClient, source: Character, copy: Character, authority: Awaited<ReturnType<typeof duplicateVisualAuthority>>, userId: string) {
  const ids = new Map<string, string>();
  for (const asset of authority.assets) ids.set(asset.id, (await cloneIdentityImage(tx, source, asset, copy, userId)).id);
  const imageAssetId = source.imageAssetId ? ids.get(source.imageAssetId) ?? null : null;
  const updated = await tx.character.update({ where: { id: copy.id }, data: { imageAssetId } });
  if (!authority.profile) {
    if (imageAssetId) await createActiveCharacterVisualProfileVersion(tx, updated, { createdFrom: "character_duplicate", anchorAssetIds: [imageAssetId] });
    return;
  }
  const references = authority.references.map(reference => ({
    mediaAssetId: ids.get(reference.mediaAssetId)!, position: reference.position, role: reference.role, weight: reference.weight,
    ...(reference.crop === null ? {} : { crop: toInputJson(reference.crop) }), qualityScore: reference.qualityScore,
    identityScore: reference.identityScore, selectionReason: reference.selectionReason,
  }));
  if (references.length === 0 && imageAssetId) references.push({
    mediaAssetId: imageAssetId, position: 0, role: "primary_face", weight: 1, qualityScore: null,
    identityScore: null, selectionReason: "primary_identity_anchor",
  });
  const p = authority.profile;
  const values = {
    characterId: copy.id, version: 1, status: "active", style: p.style, identityPrompt: p.identityPrompt,
    negativeIdentityPrompt: p.negativeIdentityPrompt, faceTraits: toInputJson(p.faceTraits), hairTraits: toInputJson(p.hairTraits),
    bodyTraits: toInputJson(p.bodyTraits), signatureTraits: toInputJson(p.signatureTraits), styleTraits: toInputJson(p.styleTraits),
    anchorAssetIds: references.filter(r => r.role === "primary_face" || r.role === "identity_anchor").map(r => r.mediaAssetId),
    defaultSeed: `character:${copy.id}:visual:1`, adapterRefs: toInputJson({ identity: jsonRecord(p.adapterRefs).identity ?? {} }),
    createdFrom: references.length ? "character_duplicate" : "generation_bootstrap:character_duplicate", evidenceState: "candidate",
  };
  const profile = await tx.characterVisualProfile.create({ data: { ...values, immutableHash: characterVisualProfileSnapshotHash(values) } });
  if (references.length) await createReferenceSetRevision(tx, profile, "character_duplicate", references);
}

async function duplicateVoiceAuthority(
  tx: Pick<Prisma.TransactionClient, "characterVoiceProfile">,
  source: { id: string; creatorId: string | null; voiceId: string | null },
) {
  if (!source.voiceId) return null;
  const profile = await tx.characterVoiceProfile.findFirst({
    where: { characterId: source.id, providerVoiceId: source.voiceId, status: "active", archivedAt: null },
    include: { referenceAsset: true, previewAsset: true },
  });
  if (!profile) throw Errors.conflict("The source Character voice is no longer active");
  for (const asset of [profile.referenceAsset, ...(profile.previewAsset ? [profile.previewAsset] : [])]) {
    if (asset.ownerId !== source.creatorId || asset.characterId !== source.id || asset.deletedAt ||
        asset.type !== "voice" || asset.safetyStatus !== "passed" ||
        !isMediaAssetOperationalForAuthority(asset.metadata) || !resolveMediaAssetBlobLocator(asset)) {
      throw Errors.conflict("The source Character voice evidence is no longer available");
    }
  }
  const metadata = jsonRecord(profile.referenceAsset.metadata);
  const presetVoiceId = typeof metadata.presetVoiceId === "string" ? metadata.presetVoiceId.trim() : "";
  const delivery = fishAudioDeliverySettingsSchema.safeParse(profile.deliverySettings);
  if (profile.provider !== "pocket_tts" || metadata.provider !== profile.provider ||
      metadata.providerVoiceId !== profile.providerVoiceId || !presetVoiceId || !delivery.success) {
    throw Errors.conflict("The source Character voice cannot be copied with its saved identity");
  }
  return {
    profile, presetVoiceId, delivery: delivery.data,
    digest: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
  };
}

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
  const before = await prisma.character.findFirst({ where: { id, deletedAt: null, creatorId: userId } });
  if (!before) throw Errors.notFound("Character not found");
  const beforeImage = before.imageAssetId ? await prisma.mediaAsset.findFirst({
    where: { id: before.imageAssetId, deletedAt: null, type: "image" },
  }) : null;
  assertDuplicateIdentityImage(beforeImage, before.imageAssetId, before);
  const visualAuthority = await prisma.$transaction(tx => duplicateVisualAuthority(tx, before));
  const voiceAuthority = await duplicateVoiceAuthority(prisma, before);
  const preparedVoice = voiceAuthority ? await prepareCharacterVoiceCopy({
    userId, sourceCharacterId: id, presetVoiceId: voiceAuthority.presetVoiceId,
    model: voiceAuthority.profile.model, language: voiceAuthority.profile.language,
    delivery: voiceAuthority.delivery, sampleText: voiceAuthority.profile.sampleText,
  }) : null;
  return prisma.$transaction(async (tx) => {
    await lockCharacterGenerationAuthority(tx, id);
    await tx.$queryRaw`SELECT id FROM characters WHERE id = ${id} FOR UPDATE`;
    const source = await tx.character.findFirst({
      where: { id, deletedAt: null, creatorId: userId },
    });
    if (!source) throw Errors.notFound("Character not found");

    const sourceImageAssetId = source.imageAssetId;
    await lockCharacterMediaAssetAuthorities(tx, [
      ...(sourceImageAssetId ? [sourceImageAssetId] : []),
      ...visualAuthority.assets.map(asset => asset.id),
      ...(voiceAuthority ? [voiceAuthority.profile.referenceAssetId, ...(voiceAuthority.profile.previewAssetId ? [voiceAuthority.profile.previewAssetId] : [])] : []),
    ]);

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
    if (lockedSource.voiceId !== before.voiceId ||
        (await duplicateVoiceAuthority(tx, lockedSource))?.digest !== voiceAuthority?.digest) {
      throw Errors.conflict("Character voice changed while the duplicate was being created");
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
    assertDuplicateIdentityImage(sourceImageAsset, sourceImageAssetId, lockedSource);
    const lockedVisualAuthority = await duplicateVisualAuthority(tx, lockedSource);
    if (lockedVisualAuthority.digest !== visualAuthority.digest) {
      throw Errors.conflict("Character visual identity changed while the duplicate was being created");
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
    const sourceTags = await tx.characterTag.findMany({ where: { characterId: id }, select: { tagId: true } });
    if (sourceTags.length) await tx.characterTag.createMany({
      data: sourceTags.map(({ tagId }) => ({ characterId: created.id, tagId })),
    });
    if (preparedVoice) await bindCharacterDraftVoice(tx, { characterId: created.id, userId, prepared: preparedVoice });
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

    await bindDuplicateVisual(tx, lockedSource, created, lockedVisualAuthority, userId);

    await tx.characterStats.create({ data: { characterId: created.id } });
    return tx.character.findUniqueOrThrow({ where: { id: created.id } });
  }).catch(async (error: unknown) => {
    if (preparedVoice) await cleanupPreparedCharacterDraftVoice(preparedVoice);
    throw error;
  });
}
