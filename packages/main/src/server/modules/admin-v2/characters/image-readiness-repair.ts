import type { Prisma } from "@prisma/client";
import type {
  CharacterImageReadinessRepairRequest,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  evaluateEditorialReleaseAuthorityInTransaction,
} from "@/server/modules/ourdream/public-release-authority";
import { draftAssetRouteEntries } from "./draft-asset-route-authority";
import {
  lockCharacterGenerationAndMediaAssetAuthorities,
} from "./generation-authority-lock";
import {
  characterImageReadinessFingerprint,
  inspectCharacterImageGenerationSource,
  type CharacterImageAssetAuthority,
} from "./image-readiness-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { findQualifiedGenerationRoute } from "./visual-authority";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
        typeof item === "string" && item.trim().length > 0
      )
    : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function visualStyle(value: unknown) {
  return ["realistic", "anime", "hybrid", "other"].includes(String(value))
    ? String(value)
    : "realistic";
}

export type PreparedCharacterImageReadinessSource = {
  readonly assetId: string;
  readonly sourceAuthority: CharacterImageAssetAuthority;
  readonly sourceAuthorityFingerprint: string;
  readonly storageKey: string | null;
  readonly contentType: string | null;
};

export async function prepareCharacterImageReadinessSource(
  characterId: string,
): Promise<PreparedCharacterImageReadinessSource> {
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    include: { imageAsset: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  if (!character.imageAssetId || !character.imageAsset) {
    throw Errors.conflict(
      "A live portrait is required before image production can be prepared",
    );
  }
  const asset = character.imageAsset;
  const source = await inspectCharacterImageGenerationSource(asset);
  if (!source.materializable) {
    throw Errors.conflict(
      "The live portrait can be displayed but cannot be materialized for image production",
      { assetId: asset.id },
    );
  }
  let storageKey: string | null = null;
  let contentType: string | null = null;
  if (source.bundled) {
    const assetKey = canonicalSha256(asset.id).slice(0, 16);
    storageKey =
      `official-editorial/${assetKey}/${source.bundled.contentSha256}${source.bundled.extension}`;
    const stored = await providers.blob.putPrivate({
      key: storageKey,
      body: source.bundled.bytes,
      contentType: source.bundled.contentType,
    });
    if (!stored.ok) {
      throw Errors.unavailable(
        "The live portrait could not be stored for image production",
        {
          assetId: asset.id,
          providerCode: stored.error.code,
        },
      );
    }
    storageKey = stored.data.key;
    contentType = source.bundled.contentType;
  }
  return {
    assetId: asset.id,
    sourceAuthority: source.authority,
    sourceAuthorityFingerprint: canonicalSha256(source.authority),
    storageKey,
    contentType,
  };
}

async function attachPreparedGenerationBlob(
  tx: Prisma.TransactionClient,
  asset: {
    readonly id: string;
    readonly url: string;
    readonly storageKey: string | null;
    readonly contentType: string | null;
    readonly metadata: Prisma.JsonValue;
  },
  prepared: PreparedCharacterImageReadinessSource,
) {
  if (hasHydratableMediaBlobAuthority(asset)) return;
  if (!prepared.storageKey) {
    throw Errors.conflict(
      "The live portrait has no prepared image-production bytes",
      { assetId: asset.id },
    );
  }
  const updated = await tx.mediaAsset.updateMany({
    where: {
      id: asset.id,
      storageKey: null,
      url: asset.url,
    },
    data: {
      storageKey: prepared.storageKey,
      contentType: prepared.contentType,
    },
  });
  if (updated.count !== 1) {
    throw Errors.conflict(
      "The live portrait changed while its image-production bytes were being attached",
      { assetId: asset.id },
    );
  }
}

export async function repairCharacterImageReadiness(input: {
  readonly characterId: string;
  readonly actor: AdminActor;
  readonly requestId: string;
  readonly request: CharacterImageReadinessRepairRequest;
  readonly prepared: PreparedCharacterImageReadinessSource;
  readonly tx: Prisma.TransactionClient;
}) {
  if (
    input.request.confirmation !==
      `PREPARE IMAGE PRODUCTION ${input.characterId}`
  ) {
    throw Errors.badRequest(
      "Confirmation did not match the Character image-readiness repair",
    );
  }
  const initialCharacter = await input.tx.character.findUnique({
    where: { id: input.characterId },
    select: { imageAssetId: true },
  });
  if (!initialCharacter) throw Errors.notFound("Character not found");
  await lockCharacterGenerationAndMediaAssetAuthorities(
    input.tx,
    input.characterId,
    initialCharacter.imageAssetId ? [initialCharacter.imageAssetId] : [],
  );

  // Prisma's pg transaction adapter uses one client connection. Keep reads
  // sequential after the authority lock so no query is issued while that
  // client is already executing another query.
  const character = await input.tx.character.findUnique({
    where: { id: input.characterId },
    include: { imageAsset: true },
  });
  if (!character) throw Errors.notFound("Character not found");
  if (character.imageAssetId !== initialCharacter.imageAssetId) {
    throw Errors.conflict(
      "The live portrait changed while image readiness was being repaired",
      {
        expectedAssetId: initialCharacter.imageAssetId,
        currentAssetId: character.imageAssetId,
      },
    );
  }
  const project = await input.tx.characterProject.findFirst({
    where: { characterId: input.characterId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  const serving = await input.tx.characterServing.findUnique({
    where: { characterId: input.characterId },
  });
  const activeIdentity = await input.tx.characterVisualProfile.findFirst({
    where: { characterId: input.characterId, status: "active" },
    orderBy: [{ version: "desc" }, { id: "desc" }],
  });
  const activeLookCount = await input.tx.characterLook.count({
    where: {
      characterId: input.characterId,
      status: { in: ["active", "needs_rebase"] },
    },
  });
  if (!project || !serving) {
    throw Errors.notFound("Character Project authority is incomplete");
  }
  if (project.version !== input.request.entityVersion) {
    throw Errors.conflict(
      "Character Project changed before image production was prepared",
      {
        expectedVersion: input.request.entityVersion,
        currentVersion: project.version,
      },
    );
  }
  if (!serving.currentReleaseId || serving.state !== "live") {
    throw Errors.conflict(
      "Only a currently live editorial Character can adopt its live portrait",
    );
  }
  const currentRelease = await input.tx.characterRelease.findUnique({
    where: { id: serving.currentReleaseId },
  });
  if (!currentRelease) {
    throw Errors.conflict("The live Character Release is unavailable");
  }
  const activeReferenceSet = activeIdentity
    ? await input.tx.referenceSetRevision.findFirst({
        where: { visualProfileId: activeIdentity.id, status: "active" },
        orderBy: [{ revision: "desc" }, { id: "desc" }],
      })
    : null;
  const currentImageSource = character.imageAsset
    ? await inspectCharacterImageGenerationSource(character.imageAsset)
    : null;
  if (
    !currentImageSource ||
    character.imageAssetId !== input.prepared.assetId ||
    canonicalSha256(currentImageSource.authority) !==
      input.prepared.sourceAuthorityFingerprint
  ) {
    throw Errors.conflict(
      "The live portrait source changed while image production was being prepared",
      {
        preparedAssetId: input.prepared.assetId,
        currentAssetId: character.imageAssetId,
      },
    );
  }
  const fingerprint = characterImageReadinessFingerprint({
    characterId: character.id,
    characterImageAssetId: character.imageAssetId,
    sourceAsset: currentImageSource.authority,
    projectId: project.id,
    projectVersion: project.version,
    draftImageAssetId: project.draftImageAssetId,
    draftAssetPack: project.draftAssetPack,
    serving: {
      currentReleaseId: serving.currentReleaseId,
      scheduledReleaseId: serving.scheduledReleaseId,
      version: serving.version,
    },
    currentRelease: {
      id: currentRelease.id,
      version: currentRelease.version,
      snapshotHash: currentRelease.snapshotHash,
    },
    activeIdentity: activeIdentity ? {
      id: activeIdentity.id,
      version: activeIdentity.version,
      immutableHash: activeIdentity.immutableHash,
    } : null,
    activeReferenceSet: activeReferenceSet ? {
      id: activeReferenceSet.id,
      revision: activeReferenceSet.revision,
      snapshotHash: activeReferenceSet.snapshotHash,
    } : null,
  });
  if (fingerprint !== input.request.expectedReadinessFingerprint) {
    throw Errors.conflict(
      "Image-production readiness changed after this workspace was loaded",
      {
        submittedFingerprint:
          input.request.expectedReadinessFingerprint,
        currentFingerprint: fingerprint,
      },
    );
  }
  if (
    project.draftImageAssetId !== null ||
    Object.keys(draftAssetRouteEntries(project.draftAssetPack)).length > 0
  ) {
    throw Errors.conflict(
      "Existing draft role images require manual review before adopting the live portrait",
    );
  }
  const candidateRelease = await input.tx.characterRelease.findFirst({
    where: {
      projectId: project.id,
      id: { not: currentRelease.id },
      status: { in: ["draft", "validating", "in_review", "approved"] },
    },
    select: { id: true, status: true },
  });
  if (candidateRelease || serving.scheduledReleaseId) {
    throw Errors.conflict(
      "Finish the active or scheduled Character Release before repairing image readiness",
      {
        candidateReleaseId: candidateRelease?.id ?? null,
        scheduledReleaseId: serving.scheduledReleaseId,
      },
    );
  }
  if (activeIdentity || activeReferenceSet || activeLookCount > 0) {
    throw Errors.conflict(
      "Existing modern identity authority requires manual visual review",
      {
        activeIdentityId: activeIdentity?.id ?? null,
        activeReferenceSetId: activeReferenceSet?.id ?? null,
        activeLookCount,
      },
    );
  }
  if (
    !character.imageAssetId ||
    !character.imageAsset ||
    currentRelease.legacy !== true ||
    currentRelease.status !== "published"
  ) {
    throw Errors.conflict(
      "A published legacy editorial portrait is required for automatic repair",
    );
  }
  const asset = character.imageAsset;
  if (
    asset.type !== "image" ||
    asset.deletedAt !== null ||
    asset.safetyStatus !== "passed" ||
    !isMediaAssetOperationalForAuthority(asset.metadata)
  ) {
    throw Errors.conflict(
      "The live portrait is unavailable for image-production authority",
    );
  }
  if (asset.characterId === null) {
    const references = await input.tx.character.findMany({
      where: { imageAssetId: asset.id },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (
      references.length !== 1 ||
      references[0]?.id !== input.characterId
    ) {
      throw Errors.conflict(
        "The live portrait is shared and cannot become this Character's identity authority",
      );
    }
    const claimed = await input.tx.mediaAsset.updateMany({
      where: { id: asset.id, characterId: null },
      data: { characterId: input.characterId },
    });
    if (claimed.count !== 1) {
      throw Errors.conflict(
        "The live portrait changed while image readiness was being repaired",
      );
    }
  } else if (asset.characterId !== input.characterId) {
    throw Errors.conflict(
      "The live portrait belongs to another Character",
    );
  }
  const editorialAuthority =
    await evaluateEditorialReleaseAuthorityInTransaction(input.tx, {
      releaseId: currentRelease.id,
    });
  if (!editorialAuthority.valid) {
    throw Errors.conflict(
      "The live editorial Release failed exact authority verification",
      {
        failureCodes: editorialAuthority.failures.map((failure) =>
          failure.code
        ),
      },
    );
  }
  if (
    editorialAuthority.characterId !== input.characterId ||
    editorialAuthority.assetId !== asset.id
  ) {
    throw Errors.conflict(
      "The live portrait does not match the editorial Release authority",
    );
  }
  await attachPreparedGenerationBlob(input.tx, asset, input.prepared);
  const content = await input.tx.characterContentVersion.findUnique({
    where: { id: currentRelease.characterContentVersionId },
  });
  if (!content || content.characterId !== input.characterId) {
    throw Errors.conflict(
      "The live Character content snapshot is unavailable",
    );
  }

  const persona = record(content.personaSnapshot);
  const appearance = record(content.appearanceSnapshot);
  const identityAnchor =
    text(appearance.identityAnchor) ||
    text(persona.description) ||
    character.description;
  const stableTraits = stringArray(appearance.stableTraits);
  const referenceDirection = text(appearance.referenceDirection);
  const style = visualStyle(appearance.style || character.style);
  const identityPrompt = [
    identityAnchor,
    stableTraits.length > 0
      ? `Stable traits: ${stableTraits.join(", ")}`
      : "",
    referenceDirection
      ? `Visual direction: ${referenceDirection}`
      : "",
  ].filter(Boolean).join(". ");
  const negativeIdentityPrompt = [
    "different person",
    "identity drift",
    "multiple people",
    "duplicate face",
    "text",
    "watermark",
    "contact sheet",
  ].join(", ");
  const faceTraits = { identityAnchor, stableTraits };
  const hairTraits = {};
  const bodyTraits = {};
  const signatureTraits = { referenceDirection };
  const styleTraits = {
    style,
    characterName: text(persona.name) || character.name,
  };
  const latestProfile = await input.tx.characterVisualProfile.aggregate({
    where: { characterId: input.characterId },
    _max: { version: true },
  });
  const visualProfileVersion = (latestProfile._max.version ?? 0) + 1;
  const profileSnapshot = {
    version: visualProfileVersion,
    style,
    identityPrompt,
    negativeIdentityPrompt,
    faceTraits,
    hairTraits,
    bodyTraits,
    signatureTraits,
    styleTraits,
    anchorAssetIds: [asset.id],
    referenceAssetIds: [asset.id],
  };
  const visualProfile = await input.tx.characterVisualProfile.create({
    data: {
      characterId: input.characterId,
      version: visualProfileVersion,
      status: "active",
      style,
      identityPrompt,
      negativeIdentityPrompt,
      faceTraits: toInputJson(faceTraits),
      hairTraits: toInputJson(hairTraits),
      bodyTraits: toInputJson(bodyTraits),
      signatureTraits: toInputJson(signatureTraits),
      styleTraits: toInputJson(styleTraits),
      anchorAssetIds: toInputJson([asset.id]),
      referenceAssetIds: toInputJson([asset.id]),
      defaultSeed: null,
      adapterRefs: toInputJson({
        authority: "editorial_live_portrait",
        sourceReleaseId: currentRelease.id,
        sourceContentVersionId: content.id,
        sourceAssetId: asset.id,
      }),
      immutableHash: characterVisualProfileSnapshotHash(profileSnapshot),
      evidenceState: "editorial_seed_adopted",
      createdFrom: `editorial_live_portrait:${currentRelease.id}`,
    },
  });
  const references = [{
    mediaAssetId: asset.id,
    position: 0,
    role: "primary_face",
    weight: 1,
  }];
  const selectorVersion = "editorial-live-portrait-v1";
  const referenceSet = await input.tx.referenceSetRevision.create({
    data: {
      visualProfileId: visualProfile.id,
      revision: 1,
      status: "active",
      selectorVersion,
      createdFrom: `editorial_live_portrait:${currentRelease.id}`,
      snapshotHash: referenceSetSnapshotHash({
        visualProfileId: visualProfile.id,
        revision: 1,
        selectorVersion,
        references,
      }),
      references: {
        create: references.map((reference) => ({
          ...reference,
          selectorVersion,
          selectionReason: input.request.reason,
        })),
      },
    },
  });
  await input.tx.referenceCandidate.create({
    data: {
      visualProfileId: visualProfile.id,
      mediaAssetId: asset.id,
      sourceJobId: null,
      proposedRole: "primary_face",
      qualityScore: null,
      identityScore: null,
      source: "editorial_live_portrait",
      status: "promoted",
      promotedRevisionId: referenceSet.id,
    },
  });
  const updatedProject = await input.tx.characterProject.updateMany({
    where: { id: project.id, version: project.version },
    data: { version: { increment: 1 } },
  });
  if (updatedProject.count !== 1) {
    throw Errors.conflict(
      "Character Project changed during image-readiness repair",
    );
  }
  const repairedAt = new Date();
  const route = await findQualifiedGenerationRoute(input.tx, {
    style,
    policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
    evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
    at: repairedAt,
    requiredReferenceCount: 1,
    requiredReferenceRoles: ["primary_face"],
  });
  const state = route ? "ready" as const : "route_pending" as const;
  await input.tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "character.image_readiness.repaired",
      targetType: "character_project",
      targetId: project.id,
      reason: input.request.reason,
      before: toInputJson({
        projectVersion: project.version,
        readinessFingerprint: fingerprint,
        activeIdentityId: null,
        activeReferenceSetId: null,
        liveReleaseId: currentRelease.id,
        liveAssetId: asset.id,
      }),
      after: toInputJson({
        projectVersion: project.version + 1,
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
        referenceSetRevisionId: referenceSet.id,
        referenceSetRevision: referenceSet.revision,
        routeQualificationId: route?.id ?? null,
        state,
      }),
      requestId: input.requestId,
    },
  });
  await input.tx.adminCollaborationActivity.create({
    data: {
      targetType: "character_project",
      targetId: project.id,
      kind: "status_change",
      actorId: input.actor.id,
      body: "Prepared the live editorial portrait for future image production",
      metadata: toInputJson({
        characterId: input.characterId,
        visualProfileId: visualProfile.id,
        referenceSetRevisionId: referenceSet.id,
        liveReleaseUnchanged: true,
        state,
      }),
      idempotencyKey:
        `character_image_readiness:${input.requestId}`,
    },
  });
  await input.tx.mainOutboxEvent.create({
    data: {
      eventType: "character.image_readiness.repaired.v1",
      aggregateType: "character",
      aggregateId: input.characterId,
      status: "delivered",
      deliveredAt: repairedAt,
      payload: toInputJson({
        characterId: input.characterId,
        projectId: project.id,
        projectVersion: project.version + 1,
        visualProfileId: visualProfile.id,
        referenceSetRevisionId: referenceSet.id,
        sourceReleaseId: currentRelease.id,
        sourceAssetId: asset.id,
        state,
      }),
    },
  });
  return {
    characterId: input.characterId,
    projectVersion: project.version + 1,
    state,
    action: "adopted_live_portrait" as const,
    visualProfileId: visualProfile.id,
    visualProfileVersion: visualProfile.version,
    referenceSetRevisionId: referenceSet.id,
    referenceSetRevision: referenceSet.revision,
    routeQualificationId: route?.id ?? null,
    routeFingerprint: route?.routeFingerprint ?? null,
    remainingBlockers: route ? [] : ["generation_route_unqualified"],
    deepLink: `/admin/characters/${input.characterId}?tab=assets`,
  };
}
