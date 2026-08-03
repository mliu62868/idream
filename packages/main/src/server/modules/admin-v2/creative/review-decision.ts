import { prisma } from "@/server/lib/db";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "../shared/prisma-json";
import {
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
  isCreativeRunVerificationTransitionAllowed,
  isCreativeRunWorkflowTransitionAllowed,
} from "../shared/state-transition-authority";
import { CHARACTER_IDENTITY_APPROVAL_MIN_SCORE } from "@idream/shared/admin";
import { operationalContentProductionBatchWhere } from "@/server/modules/metric-data-scope";
import {
  lockCharacterGenerationAuthority,
  lockCharacterMediaAssetAuthorities,
} from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { GENERATED_IMAGE_SANITY_EVALUATOR_VERSION } from "@idream/shared/media/generated-image-sanity";
import {
  approvedIdentityConsistencyForMode,
  creativeIdentityReviewMode,
  deriveCreativeRunContinuation,
} from "./run-state";
import {
  assertCustomerPublishableCreativeAsset,
  systemSingleFrameEvidence,
} from "./customer-publishable-asset";

// SPEC: 一条 Creative Run item 的评审结论（通过 / 拒绝）的唯一写入口。
// INTENT: 一次评审要同时满足身份一致性、质量清单、素材可发布性、下游依赖已解绑、
// 以及 Run/item 双 CAS —— 这些前置条件属于评审这一个动作，不是「creative 域的杂事」。

function jsonContainsString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((entry) => jsonContainsString(entry, expected));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .some((entry) => jsonContainsString(entry, expected));
  }
  return false;
}

async function characterAssetReviewDependencies(
  tx: Prisma.TransactionClient,
  characterId: string,
  assetId: string,
) {
  const character = await tx.character.findUnique({
    where: { id: characterId },
    select: { imageAssetId: true },
  });
  const project = await tx.characterProject.findFirst({
    where: { characterId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, draftImageAssetId: true, draftAssetPack: true },
  });
  const activeReference = await tx.characterVisualReferenceSnapshot.findFirst({
    where: {
      mediaAssetId: assetId,
      referenceSetRevision: {
        status: "active",
        visualProfile: { characterId, status: "active" },
      },
    },
    select: { referenceSetRevisionId: true },
  });
  const activeLook = await tx.characterLook.findFirst({
    where: {
      characterId,
      referenceAssetId: assetId,
      status: { in: ["active", "needs_rebase"] },
    },
    select: { id: true },
  });
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
    include: { currentRelease: true, scheduledRelease: true },
  });
  const dependencies: string[] = [];
  const activeRelease = project
    ? await tx.characterRelease.findFirst({
        where: {
          projectId: project.id,
          status: { in: ["draft", "validating", "in_review", "approved"] },
        },
        select: { id: true, releasePlacementManifest: true },
      })
    : null;
  const downstreamGeneration = await tx.generationJob.findFirst({
    where: {
      characterId,
      status: {
        in: [
          "queued",
          "moderating_input",
          "running",
          "moderating_output",
          "completed",
        ],
      },
      OR: [
        { referenceAssetIds: { array_contains: [assetId] } },
        {
          referenceManifest: {
            array_contains: [{ mediaAssetId: assetId }],
          },
        },
        {
          controls: {
            path: ["sourceImageAssetId"],
            equals: assetId,
          },
        },
      ],
    },
    select: { id: true },
  });
  if (character?.imageAssetId === assetId) dependencies.push("live_character_image");
  if (
    project?.draftImageAssetId === assetId ||
    (project && jsonContainsString(project.draftAssetPack, assetId))
  ) {
    dependencies.push("character_project_draft");
  }
  // 归一后「活跃视觉身份用了这张图」与「活跃参考集用了这张图」是同一个判断——参考图只存在于
  // active Reference Set。原先前者按 profile 影子列另查一次，是对同一事实的第二次覆盖。
  // 两个依赖串都保留，调用方契约不变。
  if (activeReference) {
    dependencies.push("active_visual_identity");
    dependencies.push("active_reference_set");
  }
  if (activeLook) dependencies.push("active_character_look");
  if (
    activeRelease &&
    jsonContainsString(activeRelease.releasePlacementManifest, assetId)
  ) {
    dependencies.push("active_character_release");
  }
  if (
    serving?.currentRelease &&
    jsonContainsString(serving.currentRelease.releasePlacementManifest, assetId)
  ) {
    dependencies.push("current_character_release");
  }
  if (
    serving?.scheduledRelease &&
    jsonContainsString(serving.scheduledRelease.releasePlacementManifest, assetId)
  ) {
    dependencies.push("scheduled_character_release");
  }
  if (downstreamGeneration) dependencies.push("downstream_generation_lineage");
  return dependencies;
}

export async function recordCreativeReviewDecision(input: {
  readonly runId: string;
  readonly itemId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly supersedesDecisionId?: string;
  readonly decision: "approved" | "rejected";
  readonly identityConsistency: "passed" | "failed" | "unscored";
  readonly score?: number;
  readonly quality?: {
    readonly artifactFree: boolean;
    readonly singleSubject: boolean;
    readonly intentMatch: boolean;
    readonly noVisibleText: boolean;
  };
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  if (input.reason.trim().length < 3) throw Errors.badRequest("Review reason is required");
  const execute = async (tx: Prisma.TransactionClient) => {
    const locator = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
      select: { targetType: true, targetId: true },
    });
    if (!locator) throw Errors.notFound("Creative Run not found");
    if (locator.targetType === "character" && locator.targetId) {
      await lockCharacterGenerationAuthority(tx, locator.targetId);
    }
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before review", { currentVersion: run.version });
    }
    const immutableDecisionCorrection =
      run.lifecycleState === "closed" &&
      typeof input.supersedesDecisionId === "string";
    if (
      !immutableDecisionCorrection &&
      (
        run.lifecycleState !== "active" ||
        !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, run.lifecycleState)
      )
    ) {
      throw Errors.conflict("Creative Run is not active for review", { lifecycleState: run.lifecycleState });
    }
    const characterAssetReview = [
      "character_cover",
      "character_hero",
      "character_chat",
      "character_video",
    ].includes(run.purpose);
    const characterIdentityReview = run.purpose === "identity_calibration";
    const routeEvaluationReview = run.purpose === "model_eval";
    if (characterAssetReview || characterIdentityReview) {
      if (!input.quality) {
        throw Errors.badRequest(
          characterIdentityReview
            ? "Character identity review requires the complete visible quality checklist"
            : "Character asset review requires the complete visible quality checklist",
        );
      }
      if (
        input.decision === "approved" &&
        (!input.quality.artifactFree ||
          !input.quality.singleSubject ||
          !input.quality.intentMatch ||
          !input.quality.noVisibleText)
      ) {
        throw Errors.badRequest(
          characterIdentityReview
            ? "A Character identity candidate cannot be approved while a required quality check is failing"
            : "A Character asset cannot be approved while a required quality check is failing",
        );
      }
      if (
        characterAssetReview &&
        input.decision === "approved" &&
        input.score === undefined
      ) {
        throw Errors.badRequest("Character asset approval requires an explicit score");
      }
    }
    if (
      routeEvaluationReview &&
      (
        input.identityConsistency === "unscored" ||
        input.score === undefined
      )
    ) {
      throw Errors.badRequest(
        "Model evaluation review requires an explicit identity result and identity match score",
      );
    }
    const itemLocator = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: run.id },
      select: {
        mediaAssetId: true,
        job: {
          select: {
            assets: {
              select: { id: true },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });
    if (!itemLocator) throw Errors.notFound("Creative Run item not found");
    const locatedAssetIds = [
      ...(itemLocator.mediaAssetId ? [itemLocator.mediaAssetId] : []),
      ...(itemLocator.job?.assets.map((asset) => asset.id) ?? []),
    ];
    await lockCharacterMediaAssetAuthorities(tx, locatedAssetIds);
    const item = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: run.id },
      include: {
        mediaAsset: { include: { placements: true } },
        job: {
          include: {
            assets: {
              include: { placements: true },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });
    if (!item) throw Errors.notFound("Creative Run item not found");
    const lockedAssetIds = new Set(locatedAssetIds);
    const currentAssetIds = [
      ...(item.mediaAssetId ? [item.mediaAssetId] : []),
      ...(item.job?.assets.map((asset) => asset.id) ?? []),
    ];
    if (currentAssetIds.some((assetId) => !lockedAssetIds.has(assetId))) {
      throw Errors.conflict("Creative Run asset authority changed before review");
    }
    const supersededDecision = await tx.creativeReviewDecision.findFirst({
      where: { runItemId: item.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (supersededDecision?.id !== input.supersedesDecisionId) {
      throw Errors.conflict("Creative review authority changed before this decision was recorded", {
        expectedSupersedesDecisionId: input.supersedesDecisionId ?? null,
        latestDecisionId: supersededDecision?.id ?? null,
      });
    }
    const reviewInvalidatesExistingAuthority =
      supersededDecision !== null || input.decision === "rejected";
    const reviewedAssetId =
      item.mediaAssetId ?? item.job?.assets[0]?.id ?? null;
    if (
      reviewInvalidatesExistingAuthority &&
      run.targetType === "character" &&
      run.targetId &&
      reviewedAssetId
    ) {
      const dependencies = await characterAssetReviewDependencies(
        tx,
        run.targetId,
        reviewedAssetId,
      );
      if (dependencies.length > 0) {
        throw Errors.conflict(
          "Withdraw this asset from Character draft, identity, references, and serving before rejecting or superseding its review",
          {
            characterId: run.targetId,
            assetId: reviewedAssetId,
            dependencies,
            deepLink: `/admin/characters/${run.targetId}?tab=assets`,
          },
        );
      }
    }
    const identityReviewMode = creativeIdentityReviewMode({
      purpose: run.purpose,
      sourceMeta: item.job?.sourceMeta,
    });
    const requiredIdentityConsistency = approvedIdentityConsistencyForMode(identityReviewMode);
    if (
      input.decision === "approved" &&
      requiredIdentityConsistency !== null &&
      input.identityConsistency !== requiredIdentityConsistency
    ) {
      throw Errors.badRequest(
        identityReviewMode === "defines_identity"
          ? "The first reviewed portrait defines identity and must keep identity consistency unscored"
          : "An identity-preserving Character asset can only be approved when identity consistency passes",
      );
    }
    if (
      input.decision === "approved" &&
      identityReviewMode === "preserves_identity" &&
      (
        input.score === undefined ||
        input.score < CHARACTER_IDENTITY_APPROVAL_MIN_SCORE
      )
    ) {
      throw Errors.badRequest(
        `Character asset approval requires an identity match score of at least ${CHARACTER_IDENTITY_APPROVAL_MIN_SCORE}`,
      );
    }
    if (!isCreativeRunItemTransitionAllowed(item.status, input.decision)) {
      throw Errors.conflict("Creative Run item cannot enter the requested review state", {
        from: item.status,
        to: input.decision,
      });
    }
    const projectedItemStatuses = (await tx.contentProductionItem.findMany({
      where: { batchId: run.id },
      select: { id: true, status: true },
      orderBy: { itemIndex: "asc" },
    })).map((candidate) => candidate.id === item.id ? input.decision : candidate.status);
    const continuation = deriveCreativeRunContinuation(
      projectedItemStatuses,
      { requiresVerifiedPlacement: run.purpose === "campaign" },
    );
    if (
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, continuation.lifecycleState) ||
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, continuation.workflowStage) ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, continuation.verificationState)
    ) {
      throw Errors.conflict("Creative Run cannot accept the requested review transition", {
        lifecycle: { from: run.lifecycleState, to: continuation.lifecycleState },
        workflow: { from: run.workflowStage, to: continuation.workflowStage },
        verification: { from: run.verificationState, to: continuation.verificationState },
      });
    }
    const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
    if (!asset || asset.deletedAt || asset.safetyStatus !== "passed") {
      throw Errors.badRequest("Only a valid generated asset can be reviewed");
    }
    const automaticSingleFrameEvidence =
      systemSingleFrameEvidence(asset.metadata);
    if (
      characterIdentityReview &&
      input.decision === "approved" &&
      !automaticSingleFrameEvidence
    ) {
      throw Errors.badRequest(
        "Character identity approval requires system-verified single-frame evidence",
        {
          code: "identity_single_frame_evidence_missing",
          mediaAssetId: asset.id,
          requiredEvaluatorVersion:
            GENERATED_IMAGE_SANITY_EVALUATOR_VERSION,
        },
      );
    }
    if (input.decision === "approved") {
      await assertCustomerPublishableCreativeAsset(tx, asset);
    }
    const activePlacement = asset.placements.find((placement) =>
      ["published", "scheduled"].includes(placement.status) &&
      ["pending", "verifying", "passed"].includes(placement.verificationState)
    );
    if (reviewInvalidatesExistingAuthority && activePlacement) {
      throw Errors.conflict("A staged or active placement must be withdrawn before rejecting or superseding a review", {
        placementId: activePlacement.id,
        placementStatus: activePlacement.status,
        verificationState: activePlacement.verificationState,
      });
    }
    const claimedRun = await tx.contentProductionBatch.updateMany({
      where: {
        id: run.id,
        version: run.version,
        lifecycleState: run.lifecycleState,
        workflowStage: run.workflowStage,
        verificationState: run.verificationState,
      },
      data: {
        lifecycleState: continuation.lifecycleState,
        workflowStage: continuation.workflowStage,
        verificationState: continuation.verificationState,
        status: continuation.status,
        version: { increment: 1 },
      },
    });
    if (claimedRun.count !== 1) {
      throw Errors.conflict("Creative Run changed during review", {
        expectedVersion: run.version,
      });
    }
    const claimedItem = await tx.contentProductionItem.updateMany({
      where: {
        id: item.id,
        batchId: run.id,
        version: item.version,
        status: item.status,
        mediaAssetId: item.mediaAssetId,
      },
      data: {
        mediaAssetId: asset.id,
        status: input.decision,
        reviewNote: input.reason.trim(),
        rating: input.score,
        reviewedById: input.actor.id,
        reviewedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (claimedItem.count !== 1) {
      throw Errors.conflict("Creative Run item changed during review", {
        itemId: item.id,
        expectedVersion: item.version,
      });
    }
    const decision = await tx.creativeReviewDecision.create({
      data: {
        runItemId: item.id,
        artifactId: asset.id,
        supersedesDecisionId: supersededDecision?.id ?? null,
        decision: input.decision,
        identityConsistency: input.identityConsistency,
        score: input.score,
        reason: input.reason.trim(),
        evidence: toInputJson({
          ...(input.quality ? { quality: input.quality } : {}),
          ...(automaticSingleFrameEvidence
            ? { automaticComposition: automaticSingleFrameEvidence }
            : {}),
        }),
        reviewerId: input.actor.id,
      },
    });
    const approvedItems = await tx.contentProductionItem.count({
      where: { batchId: run.id, status: { in: ["approved", "published"] } },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id, version: run.version + 1 },
      data: { approvedItems },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.run.review_decided",
        targetType: "creative_run_item",
        targetId: item.id,
        reason: input.reason.trim(),
        before: toInputJson({ status: item.status, runVersion: run.version }),
        after: toInputJson({
          decisionId: decision.id,
          supersedesDecisionId: supersededDecision?.id ?? null,
          decision: decision.decision,
          identityConsistency: decision.identityConsistency,
          score: decision.score,
          quality: input.quality ?? null,
          runVersion: updatedRun.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.review.decided.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          runItemId: item.id,
          assetId: asset.id,
          decisionId: decision.id,
          supersedesDecisionId: supersededDecision?.id ?? null,
          decision: decision.decision,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      itemId: item.id,
      decisionId: decision.id,
      decision: decision.decision,
      lifecycleState: updatedRun.lifecycleState,
      workflowStage: updatedRun.workflowStage,
      verificationState: updatedRun.verificationState,
      version: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}
