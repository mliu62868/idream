import { characterIdentityBootstrapResponseSchema } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import type {
  AdminActor,
  AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { creativeReviewQualityPassed } from "@/server/modules/admin-v2/shared/creative-review-quality";
import { loadCharacterIdentityBootstrapAuthority } from "./identity-bootstrap-authority";
import { lockCharacterGenerationAndMediaAssetAuthorities } from "./generation-authority-lock";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { buildEditorialPortraitIdentity } from "./image-readiness-repair";
import { characterWorkspaceTabLink } from "./character-deep-link";

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// SPEC: the body is whatever the manifest declares for this operation, already parsed.
// INTENT: naming the ref instead of importing the schema keeps one authority — the Route
// Handler parsed with this exact contract, so re-parsing here would only add a second
// place a contract could drift.
type BootstrapRequest = AdminV2RequestBody<
  "characterIdentityBootstrapRequestSchema+idempotency-key+if-match"
>;

export async function bootstrapCharacterIdentity(input: {
  readonly characterId: string;
  readonly actor: AdminActor;
  readonly requestId: string;
  readonly request: BootstrapRequest;
  readonly tx: Prisma.TransactionClient;
}) {
  const request = input.request;
  if (request.confirmation !== `BOOTSTRAP IDENTITY ${input.characterId}`) {
    throw Errors.badRequest("Confirmation did not match the Character identity bootstrap");
  }

  await lockCharacterGenerationAndMediaAssetAuthorities(
    input.tx,
    input.characterId,
    [request.assetId],
  );
  await input.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-identity-bootstrap:${input.characterId}`}))`;
  const bootstrapAuthority = await loadCharacterIdentityBootstrapAuthority(input.tx, input.characterId);
  const [character, project, content, serving] = await Promise.all([
    input.tx.character.findUnique({ where: { id: input.characterId } }),
    input.tx.characterProject.findFirst({
      where: { characterId: input.characterId },
      orderBy: { updatedAt: "desc" },
    }),
    input.tx.characterContentVersion.findFirst({
      where: { characterId: input.characterId },
      orderBy: { version: "desc" },
    }),
    input.tx.characterServing.findUnique({ where: { characterId: input.characterId } }),
  ]);
  if (!character || !project || !content) {
    throw Errors.notFound("Character Project draft authority is incomplete");
  }
  if (project.version !== request.entityVersion) {
    throw Errors.conflict("Character Project changed before identity bootstrap", {
      currentVersion: project.version,
    });
  }
  if (!["idea", "planned", "producing"].includes(project.phase)) {
    throw Errors.conflict("Character identity bootstrap is only allowed during planning or production", {
      phase: project.phase,
    });
  }
  if (!bootstrapAuthority.allowed) {
    throw Errors.conflict("This Character already has identity authority that cannot be bootstrapped", {
      blockers: bootstrapAuthority.blockers,
    });
  }
  if (serving?.currentReleaseId || serving?.scheduledReleaseId) {
    throw Errors.conflict("Identity cannot be bootstrapped after a Character Release has entered serving");
  }
  const activeRelease = await input.tx.characterRelease.findFirst({
    where: {
      projectId: project.id,
      status: { in: ["draft", "validating", "in_review", "approved"] },
    },
    select: { id: true, status: true },
  });
  if (activeRelease) {
    throw Errors.conflict("Identity cannot be bootstrapped while a Character Release is active", {
      releaseId: activeRelease.id,
      status: activeRelease.status,
    });
  }

  const item = await input.tx.contentProductionItem.findFirst({
    where: {
      id: request.itemId,
      batchId: request.runId,
      mediaAssetId: request.assetId,
    },
    include: {
      batch: true,
      mediaAsset: true,
      job: true,
    },
  });
  if (
    !item ||
    item.batch.targetType !== "character" ||
    item.batch.targetId !== input.characterId ||
    item.batch.purpose !== "character_cover"
  ) {
    throw Errors.badRequest("Identity anchor must come from this Character's primary portrait Run");
  }
  if (!item.job || record(item.job.sourceMeta).bootstrapIdentity !== true) {
    throw Errors.conflict("Identity anchor must come from an explicit first-portrait bootstrap Run");
  }
  if (item.job.visualProfileId !== null || item.job.referenceSetRevisionId !== null) {
    throw Errors.conflict("Identity bootstrap cannot depend on a prior identity authority");
  }
  if (
    item.job.status !== "completed" ||
    (Array.isArray(item.job.referenceAssetIds) && item.job.referenceAssetIds.length > 0)
  ) {
    throw Errors.conflict("Identity bootstrap requires a completed generation with no prior references");
  }
  const bootstrapMeta = record(item.job.sourceMeta);
  const expectedVisualBriefHash = canonicalSha256({
    characterContentVersionId: content.id,
    appearanceSnapshot: content.appearanceSnapshot,
    brief: item.batch.brief,
  });
  if (
    bootstrapMeta.bootstrapProjectVersion !== project.version ||
    bootstrapMeta.characterContentVersionId !== content.id ||
    bootstrapMeta.visualBriefHash !== expectedVisualBriefHash ||
    bootstrapMeta.bootstrapAuthorityState !== bootstrapAuthority.state ||
    bootstrapMeta.expectedIdentityHistoryFingerprint !== bootstrapAuthority.historyFingerprint ||
    bootstrapMeta.expectedIdentityVersion !== bootstrapAuthority.nextVersion
  ) {
    throw Errors.conflict("The first-portrait Run is stale against the current Character Project or identity history");
  }
  if (
    !item.mediaAsset ||
    item.mediaAsset.deletedAt ||
    item.mediaAsset.type !== "image" ||
    item.mediaAsset.safetyStatus !== "passed" ||
    !isMediaAssetOperationalForAuthority(item.mediaAsset.metadata) ||
    !hasHydratableMediaBlobAuthority(item.mediaAsset) ||
    item.mediaAsset.characterId !== input.characterId ||
    item.mediaAsset.sourceJobId !== item.job.id
  ) {
    throw Errors.conflict("The reviewed bootstrap asset is unavailable or its generation lineage is invalid");
  }
  if (!["approved", "published"].includes(item.status)) {
    throw Errors.conflict("Identity bootstrap asset must be approved before it becomes authority", {
      status: item.status,
    });
  }
  const decision = await input.tx.creativeReviewDecision.findFirst({
    where: {
      id: request.reviewDecisionId,
      runItemId: item.id,
      artifactId: item.mediaAsset.id,
    },
  });
  const latestDecision = await input.tx.creativeReviewDecision.findFirst({
    where: { runItemId: item.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (
    !decision ||
    latestDecision?.id !== decision.id ||
    decision.decision !== "approved" ||
    decision.identityConsistency !== "unscored" ||
    !creativeReviewQualityPassed(decision.evidence)
  ) {
    throw Errors.conflict("The first identity portrait requires an approved bootstrap review");
  }

  const persona = record(content.personaSnapshot);
  const {
    style,
    identityPrompt,
    negativeIdentityPrompt,
    faceTraits,
    hairTraits,
    bodyTraits,
    signatureTraits,
    styleTraits,
  } = buildEditorialPortraitIdentity({
    characterName: text(persona.name) || character.name,
    characterStyle: character.style,
    appearanceSnapshot: content.appearanceSnapshot,
    narrativeDescription:
      text(persona.description) || character.description,
  });
  const profileSnapshot = {
    version: bootstrapAuthority.nextVersion,
    style,
    identityPrompt,
    negativeIdentityPrompt,
    faceTraits,
    hairTraits,
    bodyTraits,
    signatureTraits,
    styleTraits,
    anchorAssetIds: [item.mediaAsset.id],
    referenceAssetIds: [item.mediaAsset.id],
  };
  if (bootstrapAuthority.recoverableProfileIds.length > 0) {
    await input.tx.characterVisualProfile.updateMany({
      where: {
        id: { in: [...bootstrapAuthority.recoverableProfileIds] },
        characterId: input.characterId,
        status: "active",
      },
      data: { status: "archived" },
    });
  }
  const visualProfile = await input.tx.characterVisualProfile.create({
    data: {
      characterId: input.characterId,
      version: bootstrapAuthority.nextVersion,
      status: "active",
      style,
      identityPrompt,
      negativeIdentityPrompt,
      faceTraits: toInputJson(faceTraits),
      hairTraits: toInputJson(hairTraits),
      bodyTraits: toInputJson(bodyTraits),
      signatureTraits: toInputJson(signatureTraits),
      styleTraits: toInputJson(styleTraits),
      anchorAssetIds: toInputJson([item.mediaAsset.id]),
      defaultSeed: item.job.seed ?? item.job.id,
      adapterRefs: toInputJson({
        bootstrapIdentity: true,
        generationJobId: item.job.id,
        generationProfileKey: item.job.profileId,
        generationProfileVersion: item.job.profileVersion,
        workflowKey: item.job.model,
      }),
      immutableHash: characterVisualProfileSnapshotHash(profileSnapshot),
      evidenceState: "reviewed_bootstrap",
      createdFrom: `identity_bootstrap:${item.job.id}`,
    },
  });
  const references = [{
    mediaAssetId: item.mediaAsset.id,
    position: 0,
    role: "primary_face",
    weight: 1,
  }];
  const selectorVersion = "identity-bootstrap-v1";
  const referenceSet = await input.tx.referenceSetRevision.create({
    data: {
      visualProfileId: visualProfile.id,
      revision: 1,
      status: "active",
      selectorVersion,
      createdFrom: `identity_bootstrap:${item.job.id}`,
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
          selectionReason: request.reason,
          qualityScore: decision.score,
        })),
      },
    },
  });
  await input.tx.referenceCandidate.create({
    data: {
      visualProfileId: visualProfile.id,
      mediaAssetId: item.mediaAsset.id,
      sourceJobId: item.job.id,
      proposedRole: "primary_face",
      qualityScore: decision.score,
      source: "identity_bootstrap",
      status: "promoted",
      promotedRevisionId: referenceSet.id,
    },
  });

  const nextPack = {
    character_cover: {
      assetId: item.mediaAsset.id,
      runId: item.batch.id,
      itemId: item.id,
      reviewDecisionId: decision.id,
      generationJobId: item.job.id,
      bootstrapIdentity: true,
    },
  };
  const changed = await input.tx.characterProject.updateMany({
    where: { id: project.id, version: project.version },
    data: {
      draftImageAssetId: item.mediaAsset.id,
      draftAssetPack: toInputJson(nextPack),
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1) {
    throw Errors.conflict("Character Project changed during identity bootstrap");
  }
  const updatedProject = await input.tx.characterProject.findUniqueOrThrow({
    where: { id: project.id },
  });
  await input.tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "character.identity.bootstrapped",
      targetType: "character_project",
      targetId: project.id,
      reason: request.reason,
      before: toInputJson({
        projectVersion: project.version,
        recoveredVisualProfileIds: bootstrapAuthority.recoverableProfileIds,
        identityHistoryFingerprint: bootstrapAuthority.historyFingerprint,
        referenceSetRevisionId: null,
        draftImageAssetId: project.draftImageAssetId,
      }),
      after: toInputJson({
        projectVersion: updatedProject.version,
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
        referenceSetRevisionId: referenceSet.id,
        referenceSetRevision: referenceSet.revision,
        anchorAssetId: item.mediaAsset.id,
        generationJobId: item.job.id,
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
      body: "Established the reviewed first portrait as the Character identity anchor",
      metadata: toInputJson({
        visualProfileId: visualProfile.id,
        referenceSetRevisionId: referenceSet.id,
        anchorAssetId: item.mediaAsset.id,
        projectVersion: updatedProject.version,
      }),
      idempotencyKey: `character_identity_bootstrap:${input.requestId}`,
    },
  });
  await input.tx.mainOutboxEvent.create({
    data: {
      eventType: "character.identity.bootstrapped.v2",
      aggregateType: "character_project",
      aggregateId: project.id,
      payload: toInputJson({
        characterId: input.characterId,
        projectId: project.id,
        projectVersion: updatedProject.version,
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
        referenceSetRevisionId: referenceSet.id,
        referenceSetRevision: referenceSet.revision,
        anchorAssetId: item.mediaAsset.id,
        generationJobId: item.job.id,
      }),
    },
  });
  return characterIdentityBootstrapResponseSchema.parse({
    characterId: input.characterId,
    projectVersion: updatedProject.version,
    visualProfileId: visualProfile.id,
    visualProfileVersion: visualProfile.version,
    referenceSetRevisionId: referenceSet.id,
    referenceSetRevision: referenceSet.revision,
    anchorAssetId: item.mediaAsset.id,
    draftImageAssetId: item.mediaAsset.id,
    deepLink: characterWorkspaceTabLink(input.characterId, "assets"),
    replayed: false,
  });
}
