import {
  CHARACTER_IDENTITY_APPROVAL_MIN_SCORE,
  characterDraftImageSelectionResultSchema,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { inTransaction } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { characterIdentityReviewEvidencePassed } from "@/server/modules/admin-v2/shared/creative-review-quality";
import {
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "./release-snapshot";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "./generation-authority-lock";
import {
  hasHydratableMediaBlobAuthority,
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { characterWorkspaceTabLink } from "./character-deep-link";
import { findOperationalGenerationRoute } from "./visual-authority";

type CharacterAssetPurpose = "character_cover" | "character_hero" | "character_chat";

type DraftAssetEntry = {
  assetId: string;
  runId?: string;
  itemId?: string;
  reviewDecisionId?: string;
  generationJobId?: string;
  generationRouteFingerprint?: string;
  bootstrapIdentity?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function draftAssetEntries(value: Prisma.JsonValue): Partial<Record<CharacterAssetPurpose, DraftAssetEntry>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    (["character_cover", "character_hero", "character_chat"] as const).flatMap((purpose) => {
      const entry = record[purpose];
      if (typeof entry === "string") return [[purpose, { assetId: entry }]];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const source = entry as Record<string, unknown>;
      if (typeof source.assetId !== "string") return [];
      return [[purpose, {
        assetId: source.assetId,
        ...(typeof source.runId === "string" ? { runId: source.runId } : {}),
        ...(typeof source.itemId === "string" ? { itemId: source.itemId } : {}),
        ...(typeof source.reviewDecisionId === "string" ? { reviewDecisionId: source.reviewDecisionId } : {}),
        ...(typeof source.generationJobId === "string" ? { generationJobId: source.generationJobId } : {}),
        ...(typeof source.generationRouteFingerprint === "string"
          ? { generationRouteFingerprint: source.generationRouteFingerprint }
          : {}),
        ...(source.bootstrapIdentity === true ? { bootstrapIdentity: true } : {}),
      }]];
    }),
  );
}

function draftAssetIds(value: Prisma.JsonValue): Partial<Record<CharacterAssetPurpose, string>> {
  return Object.fromEntries(
    Object.entries(draftAssetEntries(value)).map(([purpose, entry]) => [purpose, entry.assetId]),
  );
}

export async function selectCharacterDraftImage(input: {
  readonly characterId: string;
  readonly expectedProjectVersion: number;
  readonly purpose: CharacterAssetPurpose;
  readonly runId: string;
  readonly itemId: string;
  readonly assetId: string;
  readonly reviewDecisionId: string;
  readonly actor: AdminActor;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    await lockCharacterGenerationAuthority(tx, input.characterId);
    const project = await tx.characterProject.findFirst({
      where: { characterId: input.characterId },
      orderBy: { updatedAt: "desc" },
    });
    if (!project) throw Errors.notFound("Character Project not found");
    if (project.version !== input.expectedProjectVersion) {
      throw Errors.conflict("Character Project changed before the draft asset was selected", {
        currentVersion: project.version,
      });
    }
    const activeRelease = await tx.characterRelease.findFirst({
      where: {
        projectId: project.id,
        status: { in: ["draft", "validating", "in_review", "approved"] },
      },
      select: { id: true, status: true },
    });
    if (activeRelease) {
      throw Errors.conflict("The active Character Release already pins an immutable asset pack", {
        releaseId: activeRelease.id,
        status: activeRelease.status,
        deepLink: characterWorkspaceTabLink(input.characterId, "release"),
      });
    }
    const authorityProfile = await tx.characterVisualProfile.findFirst({
      where: { characterId: input.characterId, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const authorityReferenceSet = authorityProfile
      ? await tx.referenceSetRevision.findFirst({
          where: { visualProfileId: authorityProfile.id, status: "active" },
          select: {
            references: {
              orderBy: { position: "asc" },
              select: { mediaAssetId: true },
            },
          },
          orderBy: [{ revision: "desc" }, { id: "desc" }],
        })
      : null;
    await lockCharacterMediaAssetAuthorities(tx, [
      input.assetId,
      ...(authorityReferenceSet?.references.map((reference) => reference.mediaAssetId) ?? []),
    ]);
    const item = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: input.runId, mediaAssetId: input.assetId },
      include: { batch: true, mediaAsset: true, job: true },
    });
    if (
      !item ||
      item.batch.targetType !== "character" ||
      item.batch.targetId !== input.characterId ||
      item.batch.purpose !== input.purpose
    ) {
      throw Errors.badRequest("Draft asset must come from this Character's matching Asset Studio Run");
    }
    if (
      !item.mediaAsset ||
      item.mediaAsset.deletedAt ||
      item.mediaAsset.safetyStatus !== "passed" ||
      !isMediaAssetOperationalForAuthority(item.mediaAsset.metadata) ||
      !hasHydratableMediaBlobAuthority(item.mediaAsset)
    ) {
      throw Errors.badRequest("Draft asset is unavailable");
    }
    if (!item.mediaAsset.characterId || item.mediaAsset.characterId !== input.characterId) {
      throw Errors.badRequest("Draft asset does not belong to this Character");
    }
    if (!["approved", "published"].includes(item.status)) {
      throw Errors.conflict("Draft asset must be approved before selection", { status: item.status });
    }
    const sourceMeta = record(item.job?.sourceMeta);
    if (
      !item.job ||
      item.job.status !== "completed" ||
      item.job.mode !== "image" ||
      item.job.deliveredOutputCount < 1 ||
      item.job.characterId !== input.characterId ||
      item.job.sourceType !== "content_production_item" ||
      item.job.sourceId !== item.id ||
      item.mediaAsset.sourceJobId !== item.job.id ||
      sourceMeta.batchId !== item.batchId ||
      sourceMeta.purpose !== input.purpose ||
      sourceMeta.targetType !== "character" ||
      sourceMeta.targetId !== input.characterId ||
      sourceMeta.bootstrapIdentity === true
    ) {
      throw Errors.conflict("Draft asset requires complete non-bootstrap generation provenance");
    }
    const activeIdentity = await tx.characterVisualProfile.findFirst({
      where: { characterId: input.characterId, status: "active" },
      orderBy: [{ version: "desc" }, { id: "desc" }],
    });
    const activeReferenceSet = activeIdentity
      ? await tx.referenceSetRevision.findFirst({
          where: { visualProfileId: activeIdentity.id, status: "active" },
          include: {
            references: {
              include: { mediaAsset: true },
              orderBy: { position: "asc" },
            },
          },
          orderBy: [{ revision: "desc" }, { id: "desc" }],
        })
      : null;
    const canonicalReferenceIds = activeReferenceSet?.references.map((reference) => reference.mediaAssetId) ?? [];
    const pinnedReferenceIds = Array.isArray(item.job.referenceAssetIds)
      ? item.job.referenceAssetIds.filter((value): value is string => typeof value === "string")
      : [];
    const currentQualifiedRoute = activeIdentity
      ? await findOperationalGenerationRoute(tx, {
          style: activeIdentity.style,
          policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          at: new Date(),
          requiredReferenceCount: canonicalReferenceIds.length,
          requiredReferenceRoles:
            activeReferenceSet?.references.map((reference) => reference.role) ??
              [],
        })
      : null;
    const latestSucceededAttempt = item.job
      ? await tx.generationAttempt.findFirst({
          where: { requestId: item.job.id, status: "succeeded" },
          orderBy: [{ attemptNo: "desc" }, { id: "desc" }],
        })
      : null;
    const generationRouteFingerprint =
      typeof sourceMeta.generationRouteFingerprint === "string"
        ? sourceMeta.generationRouteFingerprint
        : null;
    const currentAuthorityUsable = Boolean(
      activeIdentity &&
      activeIdentity.immutableHash === characterVisualProfileSnapshotHash(activeIdentity) &&
      activeReferenceSet &&
      activeReferenceSet.snapshotHash === referenceSetSnapshotHash(activeReferenceSet) &&
      canonicalReferenceIds.length > 0 &&
      activeReferenceSet.references.every((reference) =>
        reference.mediaAsset.deletedAt === null &&
        reference.mediaAsset.type === "image" &&
        reference.mediaAsset.safetyStatus === "passed" &&
        isMediaAssetOperationalForAuthority(reference.mediaAsset.metadata) &&
        hasHydratableMediaBlobAuthority(reference.mediaAsset) &&
        reference.mediaAsset.characterId === input.characterId
      )
    );
    if (
      !currentAuthorityUsable ||
      item.job.visualProfileId !== activeIdentity?.id ||
      item.job.visualProfileVersion !== activeIdentity?.version ||
      item.job.referenceSetRevisionId !== activeReferenceSet?.id ||
      canonicalReferenceIds.some((assetId) => !pinnedReferenceIds.includes(assetId))
    ) {
      throw Errors.conflict(
        "Draft asset generation is stale against the current Visual Identity or Reference Set",
        { deepLink: characterWorkspaceTabLink(input.characterId, "assets") },
      );
    }
    if (
      !currentQualifiedRoute ||
      !generationRouteFingerprint ||
      generationRouteFingerprint !== currentQualifiedRoute.routeFingerprint ||
      sourceMeta.generationRouteQualificationId !== currentQualifiedRoute.id ||
      item.job.profileId !== currentQualifiedRoute.generationProfileKey ||
      item.job.profileVersion !== currentQualifiedRoute.generationProfileVersion ||
      item.job.model !== currentQualifiedRoute.workflowKey ||
      latestSucceededAttempt?.profileKey !== currentQualifiedRoute.generationProfileKey ||
      latestSucceededAttempt.profileVersion !== currentQualifiedRoute.generationProfileVersion ||
      latestSucceededAttempt.workflowKey !== currentQualifiedRoute.workflowKey ||
      latestSucceededAttempt.workflowVersion !== currentQualifiedRoute.workflowVersion
    ) {
      throw Errors.conflict(
        "Draft asset generation is stale against the current qualified Generation Route",
        {
          code: "draft_asset_generation_route_stale",
          currentRouteFingerprint: currentQualifiedRoute?.routeFingerprint ?? null,
          assetRouteFingerprint: generationRouteFingerprint,
          deepLink: characterWorkspaceTabLink(input.characterId, "assets"),
        },
      );
    }
    const decision = await tx.creativeReviewDecision.findFirst({
      where: {
        id: input.reviewDecisionId,
        runItemId: item.id,
        artifactId: item.mediaAsset.id,
      },
    });
    const latestDecision = await tx.creativeReviewDecision.findFirst({
      where: { runItemId: item.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (
      !decision ||
      latestDecision?.id !== decision.id ||
      !characterIdentityReviewEvidencePassed({
        bootstrapIdentity: false,
        decision: decision.decision,
        identityConsistency: decision.identityConsistency,
        score: decision.score,
        evidence: decision.evidence,
      })
    ) {
      throw Errors.conflict(
        `Draft asset requires approved identity evidence scored at least ${CHARACTER_IDENTITY_APPROVAL_MIN_SCORE} and complete visible quality evidence`,
      );
    }
    const nextAssetPack = {
      ...draftAssetEntries(project.draftAssetPack),
      [input.purpose]: {
        assetId: item.mediaAsset.id,
        runId: input.runId,
        itemId: input.itemId,
        reviewDecisionId: decision.id,
        generationJobId: item.job.id,
        generationRouteFingerprint,
      },
    };
    const changed = await tx.characterProject.updateMany({
      where: { id: project.id, version: project.version },
      data: {
        draftImageAssetId: input.purpose === "character_cover"
          ? item.mediaAsset.id
          : project.draftImageAssetId,
        draftAssetPack: toInputJson(nextAssetPack),
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) {
      throw Errors.conflict("Character Project changed during draft asset selection");
    }
    const updated = await tx.characterProject.findUniqueOrThrow({ where: { id: project.id } });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.project.draft_image_selected",
        targetType: "character_project",
        targetId: project.id,
        reason: input.reason,
        before: toInputJson({
          draftImageAssetId: project.draftImageAssetId,
          draftAssetPack: draftAssetIds(project.draftAssetPack),
          version: project.version,
        }),
        after: toInputJson({
          draftImageAssetId: updated.draftImageAssetId,
          draftAssetPack: draftAssetIds(updated.draftAssetPack),
          selectedPurpose: input.purpose,
          runId: input.runId,
          itemId: input.itemId,
          version: updated.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.adminCollaborationActivity.create({
      data: {
        targetType: "character_project",
        targetId: project.id,
        kind: "draft_saved",
        actorId: input.actor.id,
        body: `Selected an approved ${input.purpose.replace("character_", "")} asset for the next Character Release`,
        metadata: toInputJson({
          assetId: item.mediaAsset.id,
          purpose: input.purpose,
          runId: input.runId,
          itemId: input.itemId,
          projectVersion: updated.version,
        }),
        idempotencyKey: `character_project_draft_image:${input.requestId}`,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "character.project.draft_image_selected.v2",
        aggregateType: "character_project",
        aggregateId: project.id,
        payload: toInputJson({
          characterId: input.characterId,
          projectId: project.id,
          projectVersion: updated.version,
          assetId: item.mediaAsset.id,
          purpose: input.purpose,
          runId: input.runId,
          itemId: input.itemId,
        }),
      },
    });
    return characterDraftImageSelectionResultSchema.parse({
      characterId: input.characterId,
      projectVersion: updated.version,
      selectedPurpose: input.purpose,
      selectedAssetId: item.mediaAsset.id,
      draftImageAssetId: updated.draftImageAssetId,
      draftAssetPack: draftAssetIds(updated.draftAssetPack),
      deepLink: characterWorkspaceTabLink(input.characterId, "preview"),
    });
  };
  return inTransaction(db, execute);
}
