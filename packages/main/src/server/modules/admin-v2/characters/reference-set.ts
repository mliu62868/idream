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
import { lockCharacterGenerationAndMediaAssetAuthorities } from "./generation-authority-lock";
import { invalidateCharacterDraftAssetPack } from "./draft-asset-authority";
import { characterReferenceAuthorityFrom } from "./reference-authority";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";

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

  await lockCharacterGenerationAndMediaAssetAuthorities(
    input.tx,
    input.characterId,
    uniqueAssetIds,
  );
  await input.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-reference-set:${request.visualProfileId}`}))`;
  const project = await input.tx.characterProject.findFirst({
    where: { characterId: input.characterId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const activeRelease = project
    ? await input.tx.characterRelease.findFirst({
        where: {
          projectId: project.id,
          status: { in: ["draft", "validating", "in_review", "approved"] },
        },
        select: { id: true, status: true },
      })
    : null;
  if (activeRelease) {
    throw Errors.conflict(
      "Withdraw or finish the active Character Release before publishing a new Reference Set",
      {
        releaseId: activeRelease.id,
        releaseStatus: activeRelease.status,
        deepLink: `/admin/characters/${input.characterId}?tab=release`,
      },
    );
  }
  const profile = await input.tx.characterVisualProfile.findFirst({
    where: { id: request.visualProfileId, characterId: input.characterId, status: "active" },
  });
  if (!profile) throw Errors.conflict("The selected Visual Identity is not the active Character identity");
  const currentReferenceSet = await input.tx.referenceSetRevision.findFirst({
    where: { visualProfileId: profile.id, status: "active" },
    include: { references: { orderBy: { position: "asc" } } },
    orderBy: { revision: "desc" },
  });
  if (
    (currentReferenceSet?.id ?? null) !==
      request.expectedActiveReferenceSetRevisionId ||
    (currentReferenceSet?.revision ?? 0) !==
      request.expectedActiveReferenceSetRevision
  ) {
    throw Errors.conflict(
      "The active Reference Set changed after this workspace was loaded",
      {
        expectedReferenceSetRevisionId:
          request.expectedActiveReferenceSetRevisionId,
        expectedReferenceSetRevision:
          request.expectedActiveReferenceSetRevision,
        currentReferenceSetRevisionId: currentReferenceSet?.id ?? null,
        currentReferenceSetRevision: currentReferenceSet?.revision ?? 0,
        deepLink: `/admin/characters/${input.characterId}?tab=visual`,
      },
    );
  }
  // 可选参考图 = 候选图池 ∪ 当前参考集。图池（anchorAssetIds）必须并进来，它可以包含参考集
  // 之外的图，否则运营永远无法往参考集里加新图。
  // TODO(reference-authority): 图池的正确权威是 ReferenceCandidate（候选池），迁移后此处改读候选池。
  // 详见 docs/superpowers/specs/2026-07-25-visual-reference-single-authority-design.md §2.1。
  const eligibleIds = new Set([
    ...jsonStringArray(profile.anchorAssetIds),
    ...(characterReferenceAuthorityFrom(currentReferenceSet)?.refs ?? []),
  ]);
  if (uniqueAssetIds.some((id) => !eligibleIds.has(id))) {
    throw Errors.conflict("A selected reference is not pinned by the active Visual Identity");
  }
  const assets = await input.tx.mediaAsset.findMany({
    where: {
      id: { in: uniqueAssetIds },
      deletedAt: null,
      type: "image",
      safetyStatus: "passed",
      characterId: input.characterId,
    },
  });
  if (
    assets.length !== uniqueAssetIds.length ||
    assets.some((asset) =>
      !isMediaAssetOperationalForAuthority(asset.metadata) ||
      !hasHydratableMediaBlobAuthority(asset)
    )
  ) {
    throw Errors.conflict(
      "Every selected reference asset must be operational, safety-passed, and owned by this Character",
    );
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
  const invalidatedDraftAssets = await invalidateCharacterDraftAssetPack(
    input.tx,
    input.characterId,
  );
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
      after: toInputJson({
        characterId: input.characterId,
        visualProfileId: profile.id,
        revision,
        snapshotHash,
        references,
        draftAssetInvalidation: invalidatedDraftAssets,
      }),
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
