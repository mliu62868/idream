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
import {
  deriveCreativeRunContinuation,
} from "./run-state";
import {
  assertCustomerPublishableCreativeAsset,
  systemSingleFrameEvidence,
} from "./customer-publishable-asset";

// Model evaluation scores are experiment evidence. Daily asset selection and
// placement do not require or write a manual review decision.
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
    if (run.purpose !== "model_eval") {
      throw Errors.conflict("Manual asset reviews are retired; choose the asset directly in its workspace", { code: "manual_asset_review_retired" });
    }
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
    if (input.identityConsistency === "unscored" || input.score === undefined || !Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
      throw Errors.badRequest("Model evaluation requires an explicit identity result and an integer score from 0 to 100");
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
    if (input.decision === "approved" && (input.identityConsistency !== "passed" || input.score < CHARACTER_IDENTITY_APPROVAL_MIN_SCORE)) {
      throw Errors.badRequest(`Model evaluation approval requires passing identity and a score of at least ${CHARACTER_IDENTITY_APPROVAL_MIN_SCORE}`);
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
      { requiresVerifiedPlacement: false, requiresReview: true },
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
