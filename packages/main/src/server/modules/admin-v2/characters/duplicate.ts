import { createHash, randomUUID } from "node:crypto";
import {
  characterProjectProductionReadyDraftSchema,
  type CharacterProjectCreateRequest,
} from "@idream/shared/admin";
import type { MediaAsset, Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  isMediaAssetOperationalForAuthority,
  OPERATOR_UPLOAD_AUTHORITY_SCHEMA,
  resolveMediaAssetBlobLocator,
} from "@/server/lib/media-asset-authority";
import { logger } from "@/server/lib/logger";
import { providers } from "@/server/providers";
import { createReferenceSetRevision } from "@/server/modules/ourdream/generation-reference-set";
import type { AdminActor } from "../shared/authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { jsonRecord, toInputJson } from "../shared/prisma-json";
import {
  prepareCharacterProject,
  writeCharacterProject,
  type PreparedCharacterProject,
} from "./creation";
import { characterMediaViewUrl, listCharacterImageSources } from "./image-sources";
import { getCharacterProjectDraftForResume } from "./project-draft";
import { characterVisualProfileSnapshotHash } from "./release-snapshot";

// SPEC: 把一个角色复制成独立的私有草稿：Soul、视觉方向、标签、当前身份与图片库。
// INVARIANT: 副本不继承公开资格、Release、Serving、草稿选图，也不共用文件——每张图是自己的
//            MediaAsset 与 blob，源图撤下不影响副本（运营手册 §图片库）。
// INTENT: 复制等同于运营把这些文件重新导入新角色，所以来源记为 operator_upload（digest 取自实际
//         字节），原始出处留在 duplicateLineage；不伪造一个属于新角色的生成记录。

const DUPLICATE_IMAGE_LIMIT = 60;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const BLOB_COPY_CONCURRENCY = 4;
const DUPLICATE_NAME_SUFFIX = " (copy)";
const NAME_MAX_LENGTH = 120;
const FALLBACK_REFERENCE_DIRECTION = "Soft natural light, head-and-shoulders portrait, clean uncluttered background";

type CopiedImage = {
  readonly source: MediaAsset;
  readonly copyId: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};

export type PreparedCharacterDuplicate = {
  readonly sourceCharacterId: string;
  readonly request: CharacterProjectCreateRequest;
  readonly project: PreparedCharacterProject;
  readonly copied: readonly CopiedImage[];
  readonly skippedImageCount: number;
};

function duplicateName(name: string) {
  return `${name.slice(0, NAME_MAX_LENGTH - DUPLICATE_NAME_SUFFIX.length)}${DUPLICATE_NAME_SUFFIX}`;
}

async function duplicateRequest(characterId: string): Promise<CharacterProjectCreateRequest> {
  const { draft } = await getCharacterProjectDraftForResume(characterId);
  // Older official Characters predate the wizard's required visual fields.
  const identityAnchor = draft.visualDirection.identityAnchor || draft.persona.characterPromise;
  const parsed = characterProjectProductionReadyDraftSchema.safeParse({
    persona: { ...draft.persona, name: duplicateName(draft.persona.name) },
    visualDirection: {
      ...draft.visualDirection,
      identityAnchor,
      stableTraits: draft.visualDirection.stableTraits.length > 0 ? draft.visualDirection.stableTraits : [identityAnchor],
      referenceDirection: draft.visualDirection.referenceDirection || FALLBACK_REFERENCE_DIRECTION,
    },
  });
  if (!parsed.success) {
    throw Errors.conflict("This Character is missing required content. Complete it before copying.", {
      issues: parsed.error.issues.map(({ path, code }) => ({ path, code })),
    });
  }
  return {
    ...parsed.data,
    reason: { code: "character_duplicated", summary: `Duplicate Character ${characterId} as a new private draft` },
    confirmation: "CREATE CHARACTER",
  };
}

async function activeIdentity(db: Pick<Prisma.TransactionClient, "characterVisualProfile" | "referenceSetRevision">, characterId: string) {
  const profile = await db.characterVisualProfile.findFirst({
    where: { characterId, status: "active" },
    orderBy: { version: "desc" },
  });
  if (!profile) return null;
  const referenceSet = await db.referenceSetRevision.findFirst({
    where: { visualProfileId: profile.id, status: "active" },
    include: { references: { orderBy: { position: "asc" } } },
  });
  return { profile, references: referenceSet?.references ?? [] };
}

async function imagesToCopy(characterId: string): Promise<MediaAsset[]> {
  const [library, identity] = await Promise.all([
    listCharacterImageSources({ characterId, purpose: "character_library", limit: DUPLICATE_IMAGE_LIMIT }),
    activeIdentity(prisma, characterId),
  ]);
  const referenceIds = identity?.references.map((reference) => reference.mediaAssetId) ?? [];
  const ids = [...new Set([...referenceIds, ...library.items.map((item) => item.id)])];
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: ids }, characterId, type: "image", deletedAt: null, safetyStatus: "passed" },
  });
  return assets.filter((asset) => isMediaAssetOperationalForAuthority(asset.metadata));
}

async function copyImage(source: MediaAsset, copyCharacterId: string): Promise<CopiedImage | null> {
  const locator = resolveMediaAssetBlobLocator(source);
  if (!locator || !providers.blob.getPrivate) return null;
  const read = await providers.blob.getPrivate({ key: locator.key, maxBytes: MAX_IMAGE_BYTES });
  if (!read.ok) return null;
  const copyId = `media_character_upload_${randomUUID()}`;
  const extension = /\.[a-z0-9]+$/i.exec(locator.key)?.[0] ?? "";
  const storageKey = `character-images/${copyCharacterId}/${copyId}${extension}`;
  const stored = await providers.blob.putPrivate({
    key: storageKey,
    body: read.data.body,
    contentType: source.contentType ?? read.data.contentType ?? "application/octet-stream",
  });
  if (!stored.ok) return null;
  return {
    source,
    copyId,
    storageKey,
    sha256: createHash("sha256").update(read.data.body).digest("hex"),
    sizeBytes: read.data.body.byteLength,
  };
}

async function discardCopies(copied: readonly CopiedImage[]) {
  await Promise.all(copied.map(async ({ storageKey }) => {
    const deleted = await providers.blob.delete({ key: storageKey }).catch(() => null);
    if (!deleted?.ok) logger.warn({ storageKey }, "Duplicated Character image could not be discarded");
  }));
}

export async function prepareCharacterDuplicate(characterId: string): Promise<PreparedCharacterDuplicate> {
  const request = await duplicateRequest(characterId);
  const project = await prepareCharacterProject(request);
  const sources = await imagesToCopy(characterId);
  const results: (CopiedImage | null)[] = [];
  for (let start = 0; start < sources.length; start += BLOB_COPY_CONCURRENCY) {
    results.push(...await Promise.all(
      sources.slice(start, start + BLOB_COPY_CONCURRENCY).map((source) => copyImage(source, project.characterId)),
    ));
  }
  const copied = results.filter((result): result is CopiedImage => result !== null);
  return {
    sourceCharacterId: characterId,
    request,
    project,
    copied,
    skippedImageCount: sources.length - copied.length,
  };
}

function copiedAssetData(image: CopiedImage, copyCharacterId: string, actorId: string): Prisma.MediaAssetUncheckedCreateInput {
  const metadata = jsonRecord(image.source.metadata);
  const platform = jsonRecord(metadata.platformAsset as Prisma.JsonValue);
  const url = characterMediaViewUrl(image.copyId, /\.[a-z0-9]+$/i.exec(image.storageKey)?.[0] ?? "");
  return {
    id: image.copyId,
    ownerId: actorId,
    characterId: copyCharacterId,
    type: "image",
    url,
    storageKey: image.storageKey,
    contentType: image.source.contentType,
    width: image.source.width,
    height: image.source.height,
    visibility: "private",
    safetyStatus: image.source.safetyStatus,
    prompt: image.source.prompt,
    sourcePromptHash: image.source.sourcePromptHash,
    metadata: toInputJson({
      purpose: "character_library",
      source: "admin_asset_upload",
      synthetic: false,
      ...(typeof metadata.filename === "string" ? { filename: metadata.filename } : {}),
      ...(metadata.quality !== undefined ? { quality: metadata.quality } : {}),
      sizeBytes: image.sizeBytes,
      sha256: image.sha256,
      uploadAuthority: {
        schemaVersion: OPERATOR_UPLOAD_AUTHORITY_SCHEMA,
        kind: "operator_upload",
        assetId: image.copyId,
        uploadedById: actorId,
        sha256: image.sha256,
      },
      platformAsset: {
        purpose: "character_library",
        status: "draft",
        tags: Array.isArray(platform.tags) ? platform.tags : [],
        ...(typeof platform.description === "string" ? { description: platform.description } : {}),
        updatedAt: new Date().toISOString(),
      },
      duplicateLineage: {
        schemaVersion: 1,
        sourceAssetId: image.source.id,
        sourceCharacterId: image.source.characterId,
        sourceOwnerId: image.source.ownerId,
        duplicatedByUserId: actorId,
      },
    }),
  };
}

// An identity is only copied whole: a partial reference set would quietly become a different person.
async function copyIdentity(
  tx: Prisma.TransactionClient,
  prepared: PreparedCharacterDuplicate,
  copyIdBySource: ReadonlyMap<string, string>,
) {
  const identity = await activeIdentity(tx, prepared.sourceCharacterId);
  if (!identity || identity.references.length === 0) return false;
  if (identity.references.some((reference) => !copyIdBySource.has(reference.mediaAssetId))) return false;
  const copyCharacterId = prepared.project.characterId;
  const references = identity.references.map((reference) => ({
    mediaAssetId: copyIdBySource.get(reference.mediaAssetId)!,
    position: reference.position,
    role: reference.role,
    weight: reference.weight,
    ...(reference.crop === null ? {} : { crop: toInputJson(reference.crop) }),
    qualityScore: reference.qualityScore,
    identityScore: reference.identityScore,
    selectionReason: reference.selectionReason,
  }));
  const source = identity.profile;
  const values = {
    characterId: copyCharacterId,
    version: 1,
    status: "active",
    style: source.style,
    identityPrompt: source.identityPrompt,
    negativeIdentityPrompt: source.negativeIdentityPrompt,
    faceTraits: toInputJson(source.faceTraits),
    hairTraits: toInputJson(source.hairTraits),
    bodyTraits: toInputJson(source.bodyTraits),
    signatureTraits: toInputJson(source.signatureTraits),
    styleTraits: toInputJson(source.styleTraits),
    anchorAssetIds: references
      .filter((reference) => reference.role === "primary_face" || reference.role === "identity_anchor")
      .map((reference) => reference.mediaAssetId),
    defaultSeed: `character:${copyCharacterId}:visual:1`,
    adapterRefs: toInputJson({ identity: jsonRecord(source.adapterRefs).identity ?? {} }),
    createdFrom: "character_duplicate",
    evidenceState: "candidate",
  };
  const profile = await tx.characterVisualProfile.create({
    data: { ...values, immutableHash: characterVisualProfileSnapshotHash(values) },
  });
  await createReferenceSetRevision(tx, profile, "character_duplicate", references);
  return true;
}

export async function writeCharacterDuplicate(
  tx: Prisma.TransactionClient,
  input: {
    readonly actor: AdminActor;
    readonly requestId: string;
    readonly prepared: PreparedCharacterDuplicate;
  },
) {
  const { actor, requestId, prepared } = input;
  const { project, request, sourceCharacterId } = prepared;
  await writeCharacterProject(tx, {
    actor,
    requestId,
    request,
    project,
    requestHash: canonicalSha256({ commandType: "character.project.duplicate", sourceCharacterId, payload: request }),
  });
  const copyCharacterId = project.characterId;
  const copyIdBySource = new Map<string, string>();
  for (const image of prepared.copied) {
    await tx.mediaAsset.create({ data: copiedAssetData(image, copyCharacterId, actor.id) });
    copyIdBySource.set(image.source.id, image.copyId);
  }
  const identityCopied = await copyIdentity(tx, prepared, copyIdBySource);
  const tags = await tx.characterTag.findMany({ where: { characterId: sourceCharacterId }, select: { tagId: true } });
  if (tags.length > 0) {
    await tx.characterTag.createMany({ data: tags.map(({ tagId }) => ({ characterId: copyCharacterId, tagId })) });
  }
  await tx.adminAuditLog.create({
    data: {
      actorId: actor.id,
      actorRole: actor.role,
      action: "character.project.duplicated",
      targetType: "character",
      targetId: copyCharacterId,
      reason: request.reason.summary,
      after: toInputJson({
        sourceCharacterId,
        copiedImageCount: prepared.copied.length,
        skippedImageCount: prepared.skippedImageCount,
        identityCopied,
      }),
      requestId,
    },
  });
  return {
    ...project.response,
    sourceCharacterId,
    copiedImageCount: prepared.copied.length,
    skippedImageCount: prepared.skippedImageCount,
    identityCopied,
  };
}

export { discardCopies as discardCharacterDuplicateCopies };
