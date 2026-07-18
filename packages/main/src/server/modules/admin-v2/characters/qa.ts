import { randomUUID } from "node:crypto";
import {
  characterQaRunCreateRequestSchema,
  characterQaRunSchema,
  type CharacterQaRun,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
import {
  characterReferenceMediaAuthoritySelect,
  unavailableCharacterReferenceMediaIds,
} from "./reference-media-authority";
import {
  draftAssetRouteEntries,
  evaluateDraftAssetRouteAuthority,
} from "./draft-asset-route-authority";
import { findQualifiedGenerationRoute } from "./visual-authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";
import {
  discoverDraftAssetPackSourceAssetIds,
  evaluateDraftAssetPackAuthority,
} from "./draft-asset-pack-authority";

export async function createCharacterQaRun(
  request: Request,
  characterId: string,
  rawInput: unknown,
  options?: {
    readonly tx?: Prisma.TransactionClient;
    readonly actor?: { readonly id: string; readonly role: string };
    readonly requestId?: string;
  },
): Promise<CharacterQaRun> {
  const actor = options?.actor ?? await actorWithPermission(request, "character.release.review", { characterId });
  const input = characterQaRunCreateRequestSchema.parse(rawInput);
  const execute = async (tx: Prisma.TransactionClient) => {
    await lockCharacterGenerationAuthority(tx, characterId);
    const project = await tx.characterProject.findFirst({ where: { characterId } });
    if (!project) throw Errors.notFound("Character Project not found");
    if (project.version !== input.entityVersion) {
      throw Errors.conflict("Character Project changed before QA evidence was recorded", {
        expectedVersion: input.entityVersion,
        currentVersion: project.version,
      });
    }
    const activeRelease = await tx.characterRelease.findFirst({
      where: {
        projectId: project.id,
        status: { in: ["draft", "validating", "in_review", "approved"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, status: true },
    });
    if (activeRelease) {
      throw Errors.conflict(
        "Character QA cannot be recorded while an active Release candidate exists. Request changes to withdraw the candidate before recording new QA.",
        {
          code: "active_character_release_blocks_qa",
          releaseId: activeRelease.id,
          releaseStatus: activeRelease.status,
        },
      );
    }
    const referenceAuthority = await tx.characterVisualProfile.findFirst({
      where: { characterId, status: "active" },
      select: {
        referenceSetRevisions: {
          where: { status: "active" },
          orderBy: { revision: "desc" },
          take: 1,
          select: {
            references: {
              select: { mediaAssetId: true },
              orderBy: { position: "asc" },
            },
          },
        },
      },
      orderBy: { version: "desc" },
    });
    const draftAssetIds = Object.values(
      draftAssetRouteEntries(project.draftAssetPack),
    ).map((entry) => entry.assetId);
    const sourceAssetIds = await discoverDraftAssetPackSourceAssetIds(
      tx,
      project.draftAssetPack,
    );
    const authorityLockedAssetIds = [
      ...(referenceAuthority?.referenceSetRevisions[0]?.references.map(
        (reference) => reference.mediaAssetId,
      ) ?? []),
      ...draftAssetIds,
      ...sourceAssetIds,
    ];
    await lockCharacterMediaAssetAuthorities(
      tx,
      authorityLockedAssetIds,
    );
    const revision = await tx.characterRevision.findFirst({
      where: { projectId: project.id },
      orderBy: { revision: "desc" },
    });
    if (!revision) throw Errors.conflict("Character QA requires an immutable Character Revision");
    const visualProfile = await tx.characterVisualProfile.findFirst({
      where: { characterId, status: "active" },
      orderBy: { version: "desc" },
    });
    if (!visualProfile?.immutableHash) {
      throw Errors.conflict("Character QA requires a sealed active Visual Profile");
    }
    const visualProfileHash = characterVisualProfileSnapshotHash(visualProfile);
    if (visualProfile.immutableHash !== visualProfileHash) {
      throw Errors.conflict("Character QA cannot pin a Visual Profile whose sealed hash has drifted");
    }
    const referenceSet = await tx.referenceSetRevision.findFirst({
      where: { visualProfileId: visualProfile.id, status: "active" },
      include: {
        references: {
          include: {
            mediaAsset: {
              select: characterReferenceMediaAuthoritySelect,
            },
          },
          orderBy: { position: "asc" },
        },
      },
      orderBy: { revision: "desc" },
    });
    if (!referenceSet?.snapshotHash || referenceSet.references.length === 0) {
      throw Errors.conflict("Character QA requires a sealed non-empty active Reference Set");
    }
    const referenceSetHash = referenceSetSnapshotHash(referenceSet);
    if (referenceSet.snapshotHash !== referenceSetHash) {
      throw Errors.conflict("Character QA cannot pin a Reference Set whose sealed hash has drifted");
    }
    const unavailableReferenceMediaIds =
      unavailableCharacterReferenceMediaIds(referenceSet.references, characterId);
    if (unavailableReferenceMediaIds.length > 0) {
      throw Errors.conflict(
        "Character QA requires every Reference Set image to remain available for this Character",
        { unavailableReferenceMediaIds },
      );
    }
    const currentRoute = await findQualifiedGenerationRoute(tx, {
      style: visualProfile.style,
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
      at: new Date(),
      requiredReferenceCount: referenceSet.references.length,
      requiredReferenceRoles:
        referenceSet.references.map((reference) => reference.role),
    });
    const draftAssetRouteAuthority = evaluateDraftAssetRouteAuthority(
      project.draftAssetPack,
      currentRoute?.routeFingerprint ?? null,
    );
    if (
      draftAssetRouteAuthority.missingPurposes.length > 0 ||
      draftAssetRouteAuthority.invalidBootstrapPurposes.length > 0
    ) {
      throw Errors.conflict(
        "Character QA requires a complete cover, hero, and chat asset pack",
        {
          code: "draft_asset_pack_not_qa_ready",
          blockers: draftAssetRouteAuthority.qaBlockers,
          missingPurposes: draftAssetRouteAuthority.missingPurposes,
          invalidBootstrapPurposes:
            draftAssetRouteAuthority.invalidBootstrapPurposes,
          deepLink: `/admin/characters/${characterId}?tab=assets`,
        },
      );
    }
    if (draftAssetRouteAuthority.stalePurposes.length > 0) {
      throw Errors.conflict(
        "Character QA requires every selected draft asset to come from the current qualified Generation Route",
        {
          code: "draft_asset_generation_route_stale",
          currentRouteFingerprint: currentRoute?.routeFingerprint ?? null,
          stalePurposes: draftAssetRouteAuthority.stalePurposes,
          recoveryPurpose: draftAssetRouteAuthority.recoveryPurpose,
          deepLink: `/admin/characters/${characterId}?tab=assets`,
        },
      );
    }
    if (!draftAssetRouteAuthority.qaReady) {
      throw Errors.conflict(
        "Character QA requires a current effective Generation Route for the complete draft asset pack",
        {
          code: "draft_asset_pack_not_qa_ready",
          blockers: draftAssetRouteAuthority.qaBlockers,
          currentRouteFingerprint: currentRoute?.routeFingerprint ?? null,
          deepLink: `/admin/characters/${characterId}?tab=assets`,
        },
      );
    }
    if (!currentRoute) {
      throw Errors.conflict(
        "Character QA requires a current effective Generation Route",
        {
          code: "draft_asset_pack_not_qa_ready",
          deepLink: `/admin/characters/${characterId}?tab=assets`,
        },
      );
    }
    const draftAssetPackAuthority = await evaluateDraftAssetPackAuthority(tx, {
      characterId,
      draftAssetPack: project.draftAssetPack,
      visualProfile,
      referenceSet,
      currentRoute,
      authorityLockedAssetIds,
    });
    if (!draftAssetPackAuthority.ready) {
      throw Errors.conflict(
        "Character QA requires every selected image to retain valid media, review, and generation authority",
        {
          code: "draft_asset_pack_authority_invalid",
          invalidAssetPurposes:
            draftAssetPackAuthority.invalidAssetPurposes,
          invalidLineagePurposes:
            draftAssetPackAuthority.invalidLineagePurposes,
          deepLink: `/admin/characters/${characterId}?tab=assets`,
        },
      );
    }
    const id = `character-qa:${randomUUID()}`;
    const status = input.checks.every((check) => check.result === "passed") ? "passed" : "failed";
    const checks = input.checks.map((check) => ({ ...check, ownerId: actor.id }));
    const draftAssetPackHash = canonicalSha256(project.draftAssetPack);
    const evidenceHash = canonicalSha256({
      id,
      characterId,
      projectId: project.id,
      characterContentVersionId: revision.characterContentVersionId,
      projectVersion: project.version,
      visualProfileId: visualProfile.id,
      visualProfileVersion: visualProfile.version,
      visualProfileHash,
      referenceSetRevisionId: referenceSet.id,
      referenceSetRevision: referenceSet.revision,
      referenceSetHash,
      draftAssetPackHash,
      generationRouteFingerprint: currentRoute?.routeFingerprint ?? null,
      ownerId: actor.id,
      status,
      checks,
    });
    const qaRun = await tx.characterQaRun.create({
      data: {
        id,
        characterId,
        projectId: project.id,
        characterContentVersionId: revision.characterContentVersionId,
        projectVersion: project.version,
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
        visualProfileHash,
        referenceSetRevisionId: referenceSet.id,
        referenceSetRevision: referenceSet.revision,
        referenceSetHash,
        draftAssetPackHash,
        ownerId: actor.id,
        status,
        checks: toInputJson(checks),
        evidenceHash,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action: "character.qa.recorded",
        targetType: "character_qa_run",
        targetId: qaRun.id,
        reason: input.reason,
        after: toInputJson({
          characterId,
          projectId: project.id,
          characterContentVersionId: revision.characterContentVersionId,
          projectVersion: project.version,
          visualProfileId: visualProfile.id,
          visualProfileVersion: visualProfile.version,
          visualProfileHash,
          referenceSetRevisionId: referenceSet.id,
          referenceSetRevision: referenceSet.revision,
          referenceSetHash,
          draftAssetPackHash,
          generationRouteFingerprint: currentRoute?.routeFingerprint ?? null,
          status,
          evidenceHash,
        }),
        requestId: options?.requestId ?? request.headers.get("x-request-id"),
      },
    });
    await tx.adminCollaborationActivity.create({
      data: {
        targetType: "character_project",
        targetId: project.id,
        kind: "evidence_attached",
        actorId: actor.id,
        body: `Recorded immutable Character QA Run: ${status}`,
        metadata: toInputJson({
          qaRunId: qaRun.id,
          status,
          evidenceHash,
          visualProfileId: visualProfile.id,
          referenceSetRevisionId: referenceSet.id,
          draftAssetPackHash,
          generationRouteFingerprint: currentRoute?.routeFingerprint ?? null,
        }),
        idempotencyKey: `character_qa_recorded:${qaRun.id}`,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.qa.recorded.v2",
        aggregateType: "character_qa_run",
        aggregateId: qaRun.id,
        payload: toInputJson({
          qaRunId: qaRun.id,
          characterId,
          projectId: project.id,
          characterContentVersionId: revision.characterContentVersionId,
          projectVersion: project.version,
          visualProfileId: visualProfile.id,
          visualProfileVersion: visualProfile.version,
          visualProfileHash,
          referenceSetRevisionId: referenceSet.id,
          referenceSetRevision: referenceSet.revision,
          referenceSetHash,
          draftAssetPackHash,
          generationRouteFingerprint: currentRoute?.routeFingerprint ?? null,
          status,
          evidenceHash,
        }),
      },
    });
    return characterQaRunSchema.parse({
      ...qaRun,
      checks,
      createdAt: qaRun.createdAt.toISOString(),
    });
  };
  return options?.tx ? execute(options.tx) : prisma.$transaction(execute);
}
