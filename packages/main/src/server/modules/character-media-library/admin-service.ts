import { createHash, randomUUID } from "node:crypto";
import type { CharacterMediaLibraryEntry, MediaAsset, Prisma, PrismaClient } from "@prisma/client";
import {
  characterMediaLibraryCreateRequestSchema, characterMediaLibraryUpdateRequestSchema,
  characterMediaLibraryDescribeRequestSchema, characterMediaLibraryDescribeResponseSchema,
  characterMediaLibraryEntrySchema, characterMediaLibraryListResponseSchema,
  characterMediaLibraryMutationResponseSchema, characterMediaLibraryQuerySchema,
  characterMediaLibrarySearchRequestSchema, characterMediaLibrarySearchResponseSchema,
  type CharacterMediaLibraryCreateRequest, type CharacterMediaLibraryUpdateRequest,
  type CharacterMediaLibraryDescribeRequest, type CharacterMediaLibraryQuery,
  type CharacterMediaLibrarySearchRequest,
} from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { mediaByteResponse } from "@/server/lib/media-byte-response";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { effectiveCharacterIdsForPermission, effectivePermissions } from "@/server/admin/effective-permissions";
import { inspectOperatorUploadAuthority, isMediaAssetOperationalForAuthority, resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { assertMediaAssetCustomerPublishable } from "@/server/lib/media-asset-authority-query";
import { providers } from "@/server/providers";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { decodeAdminListCursor, encodeAdminListCursor, parseIsoCursorKey } from "@/server/modules/admin-v2/shared/list-cursor";
import { lockCharacterGenerationAndMediaAssetAuthorities } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { readLibrarySourceBytes } from "./media-bytes";
import { describeMediaFrames, embedMediaText, mediaLibraryModels } from "./media-models";
import { libraryDescriptorHash, libraryDescriptorText, normalizedLibraryFacts, searchCharacterMediaLibrary } from "./service";

type Db = Prisma.TransactionClient | PrismaClient;
type Mutation = { characterId: string; actor: AdminActor; idempotencyKey: string; requestId: string };

export async function listCharacterMediaLibrary(input: { characterId: string; query: CharacterMediaLibraryQuery }) {
  await requireCharacter(prisma, input.characterId);
  const query = characterMediaLibraryQuerySchema.parse(input.query);
  const { cursor, limit, ...filter } = query;
  const identity = { characterId: input.characterId, ...filter };
  const scope = "character-media-library";
  const keys = cursor ? decodeAdminListCursor(cursor, scope, identity) : null;
  if (keys && (keys.length !== 2 || typeof keys[1] !== "string")) throw Errors.badRequest("Invalid chat library cursor");
  const at = keys ? parseIsoCursorKey(keys[0], scope) : null;
  const entries = await prisma.characterMediaLibraryEntry.findMany({
    where: { characterId: input.characterId,
      ...(filter.mediaType ? { kind: filter.mediaType } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.sourceAssetId ? { sourceAssetId: filter.sourceAssetId } : {}),
      AND: [
        ...(filter.search ? [{ OR: [
          { description: { contains: filter.search, mode: "insensitive" as const } },
          { facts: { has: normalizedLibraryFacts([filter.search])[0] } },
        ] }] : []),
        ...(at && keys ? [{ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: keys[1] as string } }] }] : []),
      ],
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
  });
  const page = entries.slice(0, limit);
  const last = page.at(-1);
  const config = mediaLibraryModels();
  const visual = await currentVisualIdentity(prisma, input.characterId);
  return characterMediaLibraryListResponseSchema.parse({
    items: page.map(entryDto),
    nextCursor: entries.length > limit && last ? encodeAdminListCursor(scope, identity, [last.createdAt.toISOString(), last.id]) : null,
    capabilities: { describe: !!config.vision, search: !!config.embedding },
    visualIdentity: visual ? { visualProfileId: visual.id, visualProfileVersion: visual.version } : null,
  });
}

export async function createCharacterMediaLibraryEntry(input: Mutation & { body: CharacterMediaLibraryCreateRequest }) {
  const body = characterMediaLibraryCreateRequestSchema.parse(input.body);
  const descriptor = normalizeDescriptor(body);
  const id = `cml_${randomUUID()}`;
  const storageKey = `character-chat-library/${input.characterId}/${id}/media`;
  const thumbnailKey = `character-chat-library/${input.characterId}/${id}/thumbnail.jpg`;
  const writtenKeys: string[] = [];
  try {
    return await executeAtomicIdempotentMutation({
      ...mutationIdentity(input, "character.media_library.create", input.characterId), payload: body,
      transactionTimeoutMs: 15_000,
      prepare: async () => {
        if (body.status === "published") await requirePublishPermission(input.actor, input.characterId);
        const visual = await requireCurrentVisual(prisma, input.characterId, body.expectedVisualProfileId, body.expectedVisualProfileVersion);
        const asset = await requireLibrarySource(prisma, input.characterId, body.sourceAssetId, visual);
        const media = await readLibrarySourceBytes(asset);
        const digest = record(asset.metadata).sha256;
        if (typeof digest === "string" && digest !== media.contentHash) throw Errors.conflict("The source file no longer matches its recorded content");
        const description = { ...descriptor, kind: media.kind, durationSeconds: media.durationSeconds, hasAudio: media.hasAudio };
        const index = await prepareIndex(description, body.status === "published");
        for (const item of [
          { key: storageKey, body: media.bytes, contentType: media.contentType },
          { key: thumbnailKey, body: media.thumbnail, contentType: "image/jpeg" },
        ]) {
          writtenKeys.push(item.key);
          const stored = await providers.blob.putPrivate({ ...item, signal: AbortSignal.timeout(30_000) });
          if (!stored.ok) throw Errors.unavailable("The chat library could not preserve its own media file");
        }
        return { asset, media, index };
      },
      mutate: async (tx, prepared) => {
        await lockCharacterGenerationAndMediaAssetAuthorities(tx, input.characterId, [body.sourceAssetId]);
        if (body.status === "published") await requirePublishPermission(input.actor, input.characterId, tx);
        const visual = await requireCurrentVisual(tx, input.characterId, body.expectedVisualProfileId, body.expectedVisualProfileVersion);
        const asset = await requireLibrarySource(tx, input.characterId, body.sourceAssetId, visual);
        assertSourceUnchanged(prepared.asset, asset);
        const entry = await tx.characterMediaLibraryEntry.create({ data: {
          id, characterId: input.characterId, sourceAssetId: asset.id,
          visualProfileId: visual.id, visualProfileVersion: visual.version,
          kind: prepared.media.kind, status: body.status, ...descriptor,
          contentHash: prepared.media.contentHash, contentType: prepared.media.contentType,
          width: prepared.media.width, height: prepared.media.height,
          durationSeconds: prepared.media.durationSeconds, hasAudio: prepared.media.hasAudio,
          storageKey, thumbnailKey, descriptionSource: "operator", ...prepared.index,
          sourceSnapshot: toInputJson({ assetId: asset.id, characterId: input.characterId,
            sourceStorageKey: resolveMediaAssetBlobLocator(asset)!.key, sourceJobId: asset.sourceJobId,
            sourceFingerprint: canonicalSha256(asset), contentHash: prepared.media.contentHash,
            visualProfileId: visual.id, visualProfileVersion: visual.version, visualProfileHash: visual.immutableHash }),
          createdById: input.actor.id, updatedById: input.actor.id,
          publishedAt: body.status === "published" ? new Date() : null,
        } });
        await audit(tx, input, "created", entry);
        return { entry: entryDto(entry) };
      },
      decorateResult: (result, replayed) => ({ ...record(result), replayed }),
      validateResult: value => characterMediaLibraryMutationResponseSchema.parse(value),
    });
  } finally {
    // Each attempt writes unique keys. An ambiguous database commit is checked
    // before cleanup, so a successfully committed library copy is never erased.
    if (writtenKeys.length) {
      let persisted: { id: string } | null | undefined;
      try {
        persisted = await prisma.characterMediaLibraryEntry.findUnique({ where: { storageKey }, select: { id: true } });
      } catch (cause) {
        // Uncertainty preserves bytes and the original mutation outcome. A cleanup
        // read outage must neither erase a committed copy nor mask its receipt/error.
        logger.warn({ err: cause, entryId: id, keys: writtenKeys }, "Chat library copy ownership could not be checked for cleanup");
      }
      if (persisted === null) for (const key of writtenKeys) {
        try {
          const deleted = await providers.blob.delete({ key });
          if (!deleted.ok) logger.warn({ key }, "Uncommitted chat library file needs cleanup");
        } catch (cause) {
          logger.warn({ err: cause, key }, "Uncommitted chat library file cleanup failed");
        }
      }
    }
  }
}

export async function updateCharacterMediaLibraryEntry(input: Mutation & { entryId: string; body: CharacterMediaLibraryUpdateRequest }) {
  const body = characterMediaLibraryUpdateRequestSchema.parse(input.body);
  return executeAtomicIdempotentMutation({
    ...mutationIdentity(input, "character.media_library.update", input.entryId), payload: body, expectedVersion: body.expectedRevision,
    prepare: async () => {
      const entry = await requireEntry(prisma, input.characterId, input.entryId);
      if (entry.revision !== body.expectedRevision) throw Errors.conflict("This chat library item has changed; reload it before saving");
      if (entry.status !== "draft" || body.status !== undefined) await requirePublishPermission(input.actor, input.characterId);
      const descriptor = normalizeDescriptor({ ...entry, ...body });
      const status = body.status ?? entry.status;
      const descriptionChanged = libraryDescriptorHash({ ...entry, ...descriptor }) !== libraryDescriptorHash(entry);
      // Withdrawal must remain available when a model or source file is down.
      const index = descriptionChanged || status === "published"
        ? await prepareIndex({ ...entry, ...descriptor }, status === "published") : null;
      return { entry, descriptor, index, status };
    },
    mutate: async (tx, prepared) => {
      await lockCharacterGenerationAndMediaAssetAuthorities(tx, input.characterId, prepared.entry.sourceAssetId ? [prepared.entry.sourceAssetId] : []);
      await tx.$queryRaw`SELECT id FROM "character_media_library_entries" WHERE id = ${input.entryId} FOR UPDATE`;
      const entry = await requireEntry(tx, input.characterId, input.entryId);
      if (entry.revision !== body.expectedRevision) throw Errors.conflict("This chat library item has changed; reload it before saving");
      if (entry.status !== "draft" || body.status !== undefined) await requirePublishPermission(input.actor, input.characterId, tx);
      if (prepared.status === "published") {
        const visual = await requireCurrentVisual(tx, input.characterId, entry.visualProfileId, entry.visualProfileVersion);
        if (!entry.sourceAssetId) throw Errors.conflict("This chat library source was deleted");
        const source = await requireLibrarySource(tx, input.characterId, entry.sourceAssetId, visual);
        if (resolveMediaAssetBlobLocator(source)?.key !== record(entry.sourceSnapshot).sourceStorageKey) {
          throw Errors.conflict("This source file was replaced; add the replacement as a new library item");
        }
      }
      const updated = await tx.characterMediaLibraryEntry.update({ where: { id: entry.id }, data: {
        ...prepared.descriptor, ...(prepared.index ?? {}), status: prepared.status,
        revision: { increment: 1 }, descriptionSource: "operator", descriptorModel: null,
        updatedById: input.actor.id,
        ...(prepared.status === "published" && entry.status !== "published" ? { publishedAt: new Date() } : {}),
      } });
      await audit(tx, input, "updated", updated);
      return { entry: entryDto(updated) };
    },
    decorateResult: (result, replayed) => ({ ...record(result), replayed }),
    validateResult: value => characterMediaLibraryMutationResponseSchema.parse(value),
  });
}

export async function describeCharacterMediaLibraryAsset(input: Mutation & { body: CharacterMediaLibraryDescribeRequest }) {
  const body = characterMediaLibraryDescribeRequestSchema.parse(input.body);
  return executeAtomicIdempotentMutation({
    ...mutationIdentity(input, "character.media_library.describe", body.sourceAssetId), payload: body,
    prepare: async () => {
      const visual = await currentVisualIdentity(prisma, input.characterId);
      if (!visual) throw Errors.conflict("Activate a visual identity before preparing chat media");
      const asset = await requireLibrarySource(prisma, input.characterId, body.sourceAssetId, visual);
      const media = await readLibrarySourceBytes(asset);
      const observation = await describeMediaFrames(media);
      return { asset, result: { ...normalizeDescriptor(observation), model: observation.model, sourceSha256: media.contentHash } };
    },
    mutate: async (tx, prepared) => {
      await lockCharacterGenerationAndMediaAssetAuthorities(tx, input.characterId, [body.sourceAssetId]);
      const asset = await tx.mediaAsset.findUnique({ where: { id: body.sourceAssetId } });
      if (!asset) throw Errors.notFound("Source media was removed during observation");
      assertSourceUnchanged(prepared.asset, asset);
      return prepared.result;
    },
    validateResult: value => characterMediaLibraryDescribeResponseSchema.parse(value),
  });
}

export async function previewCharacterMediaLibrarySearch(input: { characterId: string; body: CharacterMediaLibrarySearchRequest }) {
  const startedAt = Date.now();
  const body = characterMediaLibrarySearchRequestSchema.parse(input.body);
  const visual = await currentVisualIdentity(prisma, input.characterId);
  if (!visual) throw Errors.conflict("Activate a visual identity before searching chat media");
  const matches = await searchCharacterMediaLibrary({ characterId: input.characterId, userId: "", unseenOnly: false,
    visualProfileId: visual.id, visualProfileVersion: visual.version,
    kind: body.mediaType, query: body.query, requiredFacts: body.requiredFacts, excludedFacts: body.excludedFacts,
    requestedNudity: body.nudity,
  });
  return characterMediaLibrarySearchResponseSchema.parse({ matches: matches.map(({ entry, score }) => ({
    entry: entryDto(entry), score, reasons: ["Published for this Character identity", "Explicit fact filters satisfied"],
  })), elapsedMs: Date.now() - startedAt });
}

export async function readCharacterMediaLibraryContent(input: { characterId: string; entryId: string; thumbnail: boolean; request: Request }) {
  const entry = await requireEntry(prisma, input.characterId, input.entryId);
  const key = input.thumbnail ? entry.thumbnailKey : entry.storageKey;
  if (!key || !providers.blob.getPrivate) throw Errors.notFound("Chat library preview is unavailable");
  const stored = await providers.blob.getPrivate({ key, maxBytes: 100 * 1024 * 1024, signal: input.request.signal });
  if (!stored.ok) throw Errors.notFound("Chat library preview is unavailable");
  if (!input.thumbnail && createHash("sha256").update(stored.data.body).digest("hex") !== entry.contentHash) {
    throw Errors.conflict("The preserved chat library file no longer matches its recorded content");
  }
  return mediaByteResponse(input.request, stored.data.body, {
    "Content-Type": input.thumbnail ? "image/jpeg" : entry.contentType,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  });
}

function entryDto(entry: CharacterMediaLibraryEntry) {
  const characterId = entry.characterId ?? record(entry.sourceSnapshot).characterId;
  const sourceAssetId = entry.sourceAssetId ?? record(entry.sourceSnapshot).assetId;
  const url = `/api/v2/admin/characters/${characterId}/media-library/${entry.id}/content`;
  return characterMediaLibraryEntrySchema.parse({
    id: entry.id, characterId, sourceAssetId, mediaType: entry.kind, status: entry.status,
    visualProfileId: entry.visualProfileId, visualProfileVersion: entry.visualProfileVersion, revision: entry.revision,
    description: entry.description, facts: entry.facts, absentFacts: entry.absentFacts, nudity: entry.nudity,
    descriptionSource: entry.descriptionSource, sourceSha256: entry.contentHash, url,
    thumbnailUrl: entry.thumbnailKey ? `${url}?thumbnail=1` : null,
    width: entry.width, height: entry.height, durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio,
    createdAt: entry.createdAt.toISOString(), updatedAt: entry.updatedAt.toISOString(),
  });
}

async function requireEntry(db: Db, characterId: string, entryId: string) {
  const entry = await db.characterMediaLibraryEntry.findFirst({ where: { id: entryId, characterId } });
  if (!entry) throw Errors.notFound("Chat library item not found");
  return entry;
}
async function requireCharacter(db: Db, characterId: string) {
  const character = await db.character.findFirst({ where: { id: characterId, deletedAt: null } });
  if (!character) throw Errors.notFound("Character not found");
  if (character.age < 18) throw Errors.badRequest("Chat library Characters must be adults");
  return character;
}
async function currentVisualIdentity(db: Db, characterId: string) {
  await requireCharacter(db, characterId);
  const visual = await db.characterVisualProfile.findFirst({ where: { characterId, status: "active" }, orderBy: { version: "desc" } });
  return visual && visual.immutableHash === characterVisualProfileSnapshotHash(visual) ? visual : null;
}
async function requireCurrentVisual(db: Db, characterId: string, id: string, version: number) {
  const visual = await currentVisualIdentity(db, characterId);
  if (!visual || visual.id !== id || visual.version !== version) throw Errors.conflict("The Character visual identity changed; reload before preparing chat media");
  return visual;
}

/** Platform generation or an explicit operator library import are the only
 * sources. A customer's private output never becomes a shared candidate merely
 * because its characterId matches. */
async function requireLibrarySource(db: Db, characterId: string, assetId: string, visual: { id: string; version: number }) {
  await requireCharacter(db, characterId);
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.characterId !== characterId || !["image", "video"].includes(asset.type) || asset.deletedAt ||
      asset.safetyStatus !== "passed" || !isMediaAssetOperationalForAuthority(asset.metadata) || !resolveMediaAssetBlobLocator(asset)) {
    throw Errors.badRequest("Choose an available image or video from this Character library");
  }
  const metadata = record(asset.metadata);
  const purpose = record(metadata.platformAsset).purpose ?? metadata.purpose;
  const upload = inspectOperatorUploadAuthority(asset);
  if (upload?.publishable) {
    if (purpose !== (asset.type === "video" ? "character_video_library" : "character_library")) {
      throw Errors.forbidden("This import is not authorized for the Character media library");
    }
  } else {
    const item = await db.contentProductionItem.findFirst({ where: { mediaAssetId: asset.id,
      status: { in: ["generated", "approved", "published"] },
      batch: { targetType: "character", targetId: characterId, lifecycleState: "active" },
    }, include: { job: true } });
    if (!item?.job || item.job.id !== asset.sourceJobId || item.job.characterId !== characterId ||
        item.job.visualProfileId !== visual.id || item.job.visualProfileVersion !== visual.version) {
      throw Errors.forbidden("Only platform Character production with this visual identity may enter the shared chat library");
    }
  }
  await assertMediaAssetCustomerPublishable(db, asset);
  return asset;
}

function normalizeDescriptor(input: { description: string; facts: string[]; absentFacts: string[]; nudity: string }) {
  const facts = normalizedLibraryFacts(input.facts);
  const absentFacts = normalizedLibraryFacts(input.absentFacts);
  if (facts.some(fact => absentFacts.includes(fact))) throw Errors.badRequest("A media fact cannot be both present and absent");
  return { description: input.description.trim(), facts, absentFacts, nudity: input.nudity };
}
async function prepareIndex(descriptor: Parameters<typeof libraryDescriptorText>[0], required: boolean) {
  const config = mediaLibraryModels();
  if (!config.embedding) {
    if (required) throw Errors.unavailable("Configure character media embeddings before publishing chat library items");
    return { embedding: [], embeddingModel: null, embeddingDimensions: null, embeddingHash: null };
  }
  const embedded = await embedMediaText(libraryDescriptorText(descriptor), config.embedding);
  return { embedding: embedded.vector, embeddingModel: embedded.model, embeddingDimensions: embedded.dimensions,
    embeddingHash: libraryDescriptorHash(descriptor) };
}
async function requirePublishPermission(actor: AdminActor, characterId: string, db: Db = prisma) {
  if (!(await effectivePermissions(actor.id, actor.role, db)).has("character.release.publish")) throw Errors.forbidden("Publishing or changing published chat media requires Character publish permission");
  const ids = await effectiveCharacterIdsForPermission(actor.id, actor.role, "character.release.publish");
  if (ids !== null && !ids.has(characterId)) throw Errors.forbidden("Character is outside the publication permission scope");
}
function assertSourceUnchanged(before: MediaAsset, after: MediaAsset) {
  if (canonicalSha256(before) !== canonicalSha256(after)) {
    throw Errors.conflict("Source media changed during preparation; reload it before trying again");
  }
}
function mutationIdentity(input: Mutation, commandType: string, targetId: string) {
  return { environment: env.APP_ENV, actor: input.actor, idempotencyKey: input.idempotencyKey,
    requestId: input.requestId, commandType, target: { type: "character_media_library", id: targetId } };
}
async function audit(tx: Prisma.TransactionClient, input: Mutation, action: string, entry: CharacterMediaLibraryEntry) {
  await tx.adminAuditLog.create({ data: { actorId: input.actor.id, actorRole: input.actor.role,
    action: `character.media_library.${action}`, targetType: "character_media_library", targetId: entry.id,
    reason: "Prepare observed Character media for reusable chat delivery", requestId: input.requestId,
    after: toInputJson({ characterId: input.characterId, entryId: entry.id, revision: entry.revision,
      sourceAssetId: entry.sourceAssetId, contentHash: entry.contentHash, status: entry.status }) } });
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
