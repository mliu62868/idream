import type { Prisma } from "@prisma/client";
import {
  characterReferenceSetPublishRequestSchema,
  characterReferenceSetPublishResponseSchema,
  type CharacterReferenceSetPublishRequest,
} from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { referenceSetSnapshotHash } from "./release-snapshot";

export async function publishCharacterReferenceSet(input: {
  characterId: string;
  actor: AdminActor;
  requestId: string;
  request: CharacterReferenceSetPublishRequest;
  tx: Prisma.TransactionClient;
}) {
  const request = characterReferenceSetPublishRequestSchema.parse(input.request);
  if (request.confirmation !== `PUBLISH REFERENCES ${input.characterId}`) {
    throw Errors.badRequest("Confirmation did not match the Character reference publication");
  }
  const uniqueAssetIds = [...new Set(request.references.map((item) => item.mediaAssetId))];
  if (uniqueAssetIds.length !== request.references.length) {
    throw Errors.badRequest("Reference assets must be unique within a published snapshot");
  }

  await input.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-reference-set:${request.visualProfileId}`}))`;
  const profile = await input.tx.characterVisualProfile.findFirst({
    where: { id: request.visualProfileId, characterId: input.characterId, status: "active" },
  });
  if (!profile) throw Errors.conflict("The selected Visual Identity is not the active Character identity");
  const eligibleIds = new Set([
    ...jsonStringArray(profile.anchorAssetIds),
    ...jsonStringArray(profile.referenceAssetIds),
  ]);
  if (uniqueAssetIds.some((id) => !eligibleIds.has(id))) {
    throw Errors.conflict("A selected reference is not pinned by the active Visual Identity");
  }
  const assets = await input.tx.mediaAsset.findMany({ where: { id: { in: uniqueAssetIds } } });
  if (assets.length !== uniqueAssetIds.length) {
    throw Errors.conflict("Every selected reference asset must still be available");
  }
  const latest = await input.tx.referenceSetRevision.aggregate({
    where: { visualProfileId: profile.id },
    _max: { revision: true },
  });
  const revision = (latest._max.revision ?? 0) + 1;
  const references = request.references.map((reference, position) => ({
    mediaAssetId: reference.mediaAssetId,
    position,
    role: reference.role,
    weight: reference.weight,
  }));
  const snapshotHash = referenceSetSnapshotHash({
    visualProfileId: profile.id,
    revision,
    selectorVersion: request.selectorVersion,
    references,
  });
  await input.tx.referenceSetRevision.updateMany({
    where: { visualProfileId: profile.id, status: "active" },
    data: { status: "superseded" },
  });
  const created = await input.tx.referenceSetRevision.create({
    data: {
      visualProfileId: profile.id,
      revision,
      status: "active",
      selectorVersion: request.selectorVersion,
      createdFrom: `admin:${input.actor.id}`,
      snapshotHash,
      references: {
        create: references.map((reference) => ({
          ...reference,
          selectorVersion: request.selectorVersion,
          selectionReason: `${request.reason.code}: ${request.reason.summary}`,
        })),
      },
    },
    include: { references: { include: { mediaAsset: true }, orderBy: { position: "asc" } } },
  });
  await input.tx.referenceCandidate.updateMany({
    where: { visualProfileId: profile.id, mediaAssetId: { in: uniqueAssetIds } },
    data: { status: "promoted", promotedRevisionId: created.id },
  });
  await input.tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "character.reference_set.published",
      targetType: "reference_set_revision",
      targetId: created.id,
      reason: `${request.reason.code}: ${request.reason.summary}`,
      after: toInputJson({ characterId: input.characterId, visualProfileId: profile.id, revision, snapshotHash, references }),
      requestId: input.requestId,
    },
  });
  await input.tx.mainOutboxEvent.create({
    data: {
      eventType: "character.reference_set.published.v2",
      aggregateType: "character",
      aggregateId: input.characterId,
      payload: toInputJson({ referenceSetRevisionId: created.id, visualProfileId: profile.id, revision, snapshotHash }),
    },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  return characterReferenceSetPublishResponseSchema.parse({
    id: created.id,
    revision: created.revision,
    status: created.status,
    selectorVersion: created.selectorVersion,
    snapshotHash: created.snapshotHash,
    createdFrom: created.createdFrom,
    createdAt: created.createdAt.toISOString(),
    references: created.references.map((reference) => {
      const asset = assetById.get(reference.mediaAssetId);
      return {
        mediaAssetId: reference.mediaAssetId,
        role: reference.role,
        available: Boolean(asset),
        url: asset?.url ?? null,
        thumbnailUrl: asset?.thumbnailUrl ?? null,
        qualityScore: reference.qualityScore,
        identityScore: reference.identityScore,
      };
    }),
    replayed: false,
  });
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
