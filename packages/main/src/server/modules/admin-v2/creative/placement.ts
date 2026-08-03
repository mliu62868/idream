import { prisma } from "@/server/lib/db";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "../shared/prisma-json";
import {
  isCreativePlacementVerificationTransitionAllowed,
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
  isCreativeRunVerificationTransitionAllowed,
  isCreativeRunWorkflowTransitionAllowed,
} from "../shared/state-transition-authority";
import { resolveCommunityCampaignPlacements } from "@/server/modules/ourdream/community-campaigns";
import { operationalContentProductionBatchWhere } from "@/server/modules/metric-data-scope";
import {
  CREATIVE_MEDIA_AUTHORITY_METADATA_KEY,
  parseCreativeMediaAuthorityEvidence,
} from "@/server/lib/creative-media-authority";
import { deriveCreativeRunContinuation } from "./run-state";
import { assertCustomerPublishableCreativeAsset } from "./customer-publishable-asset";
import { jsonRecord } from "./json";

// SPEC: Creative 素材在运行时投放位上的三个动作 —— 上架待验、撤回、验证。
// INTENT: 这三个动作写的是 MediaAssetPlacement 这个独立聚合，有自己的投放位咨询锁、
// 自己的 verification 状态机和自己的回滚目标；Run 的状态变化是它们的副产物而不是主体。

const RELEASE_OWNED_SLOTS = new Set(["character_avatar", "character_hero", "character_chat"]);

export async function publishDistributionPlacement(input: {
  readonly runId: string;
  readonly itemId: string;
  readonly assetId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly slot: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly ctaLabel?: string;
  readonly href?: string;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  if (RELEASE_OWNED_SLOTS.has(input.slot)) {
    throw Errors.forbidden("Release-owned placements require a Character Release patch and publish command", {
      code: "release_owned_placement_requires_release_patch",
      slot: input.slot,
    });
  }
  if (input.slot !== "campaign" || input.targetType !== "campaign") {
    throw Errors.conflict("Only the verified campaign runtime surface is available for Creative placement", {
      code: "creative_runtime_surface_not_supported",
      slot: input.slot,
      targetType: input.targetType,
    });
  }
  const execute = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creative-placement:${input.slot}:${input.targetType}:${input.targetId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${input.assetId}`}))`;
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before placement", { currentVersion: run.version });
    }
    if (
      run.lifecycleState !== "active" ||
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, run.lifecycleState)
    ) {
      throw Errors.conflict("Creative Run is not active for placement", { lifecycleState: run.lifecycleState });
    }
    if (run.purpose !== "campaign") {
      throw Errors.conflict("Only Campaign Creative Runs can enter runtime placement verification", {
        purpose: run.purpose,
      });
    }
    if (
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, "verification") ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, "verifying")
    ) {
      throw Errors.conflict("Creative Run cannot enter placement verification from its present state", {
        workflow: { from: run.workflowStage, to: "verification" },
        verification: { from: run.verificationState, to: "verifying" },
      });
    }
    const item = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: run.id, mediaAssetId: input.assetId },
      include: { mediaAsset: true },
    });
    if (!item || !item.mediaAsset) throw Errors.notFound("Approved Creative asset not found");
    if (!isCreativeRunItemTransitionAllowed(item.status, "published")) {
      throw Errors.conflict("Creative Run item must be approved before placement", { status: item.status });
    }
    if (item.mediaAsset.deletedAt || item.mediaAsset.safetyStatus !== "passed") {
      throw Errors.badRequest("Placement asset is not valid");
    }
    const customerMediaAuthority = await assertCustomerPublishableCreativeAsset(
      tx,
      item.mediaAsset,
      undefined,
      { requireCompleteProviderAuthority: true },
    );
    const latestReview = await tx.creativeReviewDecision.findFirst({
      where: { runItemId: item.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (
      !latestReview ||
      latestReview.artifactId !== input.assetId ||
      latestReview.decision !== "approved"
    ) {
      throw Errors.badRequest("An approved immutable review decision is required before placement");
    }
    const rollbackTarget = await tx.mediaAssetPlacement.findFirst({
      where: {
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "published",
        verificationState: "passed",
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    });
    const stagedPlacement = await tx.mediaAssetPlacement.findFirst({
      where: {
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "scheduled",
        verificationState: "verifying",
      },
      select: { id: true },
    });
    if (stagedPlacement) {
      throw Errors.conflict("Another placement is already awaiting verification for this target", {
        placementId: stagedPlacement.id,
      });
    }
    const claimedRun = await tx.contentProductionBatch.updateMany({
      where: {
        id: run.id,
        version: run.version,
        lifecycleState: "active",
        workflowStage: run.workflowStage,
        verificationState: run.verificationState,
      },
      data: {
        workflowStage: "verification",
        verificationState: "verifying",
        version: { increment: 1 },
      },
    });
    if (claimedRun.count !== 1) {
      throw Errors.conflict("Creative Run changed during placement", {
        expectedVersion: run.version,
      });
    }
    const claimedItem = await tx.contentProductionItem.updateMany({
      where: {
        id: item.id,
        batchId: run.id,
        version: item.version,
        status: item.status,
        mediaAssetId: input.assetId,
      },
      data: { version: { increment: 1 } },
    });
    if (claimedItem.count !== 1) {
      throw Errors.conflict("Creative Run item changed during placement", {
        itemId: item.id,
        expectedVersion: item.version,
      });
    }
    const placement = await tx.mediaAssetPlacement.create({
      data: {
        mediaAssetId: input.assetId,
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "scheduled",
        createdById: input.actor.id,
        metadata: toInputJson({
          creativeRunId: run.id,
          creativeRunItemId: item.id,
          eyebrow: input.eyebrow,
          title: input.title,
          ...(input.ctaLabel ? { ctaLabel: input.ctaLabel } : {}),
          ...(input.href ? { href: input.href } : {}),
          [CREATIVE_MEDIA_AUTHORITY_METADATA_KEY]: customerMediaAuthority,
        }),
        verificationState: "verifying",
        rollbackPlacementId: rollbackTarget?.id,
      },
    });
    const updatedRun = await tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: run.id },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.placement.staged",
        targetType: "media_asset_placement",
        targetId: placement.id,
        reason: input.reason,
        before: toInputJson({ rollbackPlacementId: rollbackTarget?.id ?? null, runVersion: run.version }),
        after: toInputJson({
          mediaAssetId: placement.mediaAssetId,
          slot: placement.slot,
          targetType: placement.targetType,
          targetId: placement.targetId,
          verificationState: placement.verificationState,
          runVersion: updatedRun.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.placement.verification_requested.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          itemId: item.id,
          placementId: placement.id,
          expectedAssetId: placement.mediaAssetId,
          slot: placement.slot,
          targetType: placement.targetType,
          targetId: placement.targetId,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      placementId: placement.id,
      verificationState: placement.verificationState,
      rollbackPlacementId: placement.rollbackPlacementId,
      runVersion: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function withdrawCreativePlacement(input: {
  readonly runId: string;
  readonly placementId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before placement withdrawal", {
        currentVersion: run.version,
      });
    }
    const placement = await tx.mediaAssetPlacement.findUnique({
      where: { id: input.placementId },
    });
    if (!placement) throw Errors.notFound("Creative placement not found");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creative-placement:${placement.slot}:${placement.targetType}:${placement.targetId}`}))`;
    const metadata = jsonRecord(placement.metadata);
    if (metadata.creativeRunId !== run.id) {
      throw Errors.notFound("Placement does not belong to Creative Run");
    }
    if (placement.status !== "scheduled" || placement.verificationState !== "verifying") {
      throw Errors.conflict("Only a staged placement can be withdrawn", {
        status: placement.status,
        verificationState: placement.verificationState,
      });
    }
    if (
      run.lifecycleState !== "active" ||
      run.workflowStage !== "verification" ||
      run.verificationState !== "verifying" ||
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, "active") ||
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, "placement") ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, "pending") ||
      !isCreativePlacementVerificationTransitionAllowed(placement.verificationState, "overridden")
    ) {
      throw Errors.conflict("Creative Run cannot withdraw the staged placement from its present state", {
        lifecycleState: run.lifecycleState,
        workflowStage: run.workflowStage,
        runVerificationState: run.verificationState,
        placementVerificationState: placement.verificationState,
      });
    }
    const withdrawnAt = new Date();
    const claimedRun = await tx.contentProductionBatch.updateMany({
      where: {
        id: run.id,
        version: run.version,
        lifecycleState: "active",
        workflowStage: "verification",
        verificationState: "verifying",
      },
      data: {
        workflowStage: "placement",
        verificationState: "pending",
        status: "reviewing",
        version: { increment: 1 },
      },
    });
    if (claimedRun.count !== 1) {
      throw Errors.conflict("Creative Run changed during placement withdrawal", {
        expectedVersion: run.version,
      });
    }
    const claimedPlacement = await tx.mediaAssetPlacement.updateMany({
      where: {
        id: placement.id,
        version: placement.version,
        status: "scheduled",
        verificationState: "verifying",
      },
      data: {
        status: "archived",
        verificationState: "overridden",
        archivedAt: withdrawnAt,
        verificationEvidence: toInputJson({
          disposition: "operator_withdrawn",
          reason: input.reason,
          withdrawnAt: withdrawnAt.toISOString(),
          rollbackPlacementId: placement.rollbackPlacementId,
        }),
        version: { increment: 1 },
      },
    });
    if (claimedPlacement.count !== 1) {
      throw Errors.conflict("Creative placement changed during withdrawal", {
        placementId: placement.id,
        expectedVersion: placement.version,
      });
    }
    const updatedRun = await tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: run.id },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.placement.withdrawn",
        targetType: "media_asset_placement",
        targetId: placement.id,
        reason: input.reason,
        before: toInputJson({
          placementStatus: placement.status,
          placementVerificationState: placement.verificationState,
          runVersion: run.version,
          runVerificationState: run.verificationState,
        }),
        after: toInputJson({
          placementStatus: "archived",
          placementVerificationState: "overridden",
          runVersion: updatedRun.version,
          runVerificationState: updatedRun.verificationState,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.placement.withdrawn.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          placementId: placement.id,
          itemId: typeof metadata.creativeRunItemId === "string"
            ? metadata.creativeRunItemId
            : null,
          verificationState: "overridden",
          runVerificationState: updatedRun.verificationState,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      placementId: placement.id,
      verificationState: "overridden" as const,
      runVersion: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function verifyCreativePlacement(input: {
  readonly runId: string;
  readonly placementId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findFirst({
      where: operationalContentProductionBatchWhere({ id: input.runId }),
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before placement verification", { currentVersion: run.version });
    }
    let placement = await tx.mediaAssetPlacement.findUnique({
      where: { id: input.placementId },
      include: { mediaAsset: true },
    });
    if (!placement) throw Errors.notFound("Creative placement not found");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`creative-placement:${placement.slot}:${placement.targetType}:${placement.targetId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${placement.mediaAssetId}`}))`;
    placement = await tx.mediaAssetPlacement.findUnique({
      where: { id: input.placementId },
      include: { mediaAsset: true },
    });
    if (!placement) throw Errors.notFound("Creative placement not found");
    const metadata = placement.metadata as Record<string, unknown>;
    if (metadata.creativeRunId !== run.id) throw Errors.notFound("Placement does not belong to Creative Run");
    if (placement.status !== "scheduled" || placement.verificationState !== "verifying") {
      throw Errors.conflict("Only a staged placement can be verified", {
        status: placement.status,
        verificationState: placement.verificationState,
      });
    }
    const authorityEvidence = parseCreativeMediaAuthorityEvidence(
      placement.metadata,
    );
    if (authorityEvidence.kind !== "present") {
      throw Errors.badRequest(
        "Creative placement provider authority evidence is missing or malformed",
        {
          code: "creative_asset_not_customer_publishable",
          mediaAssetId: placement.mediaAsset.id,
          reasons: [
            authorityEvidence.kind === "missing"
              ? "provider_authority_evidence_missing"
              : "provider_authority_evidence_invalid",
          ],
        },
      );
    }
    await assertCustomerPublishableCreativeAsset(
      tx,
      placement.mediaAsset,
      authorityEvidence.snapshot,
      { requireCompleteProviderAuthority: true },
    );
    const runItemId = typeof metadata.creativeRunItemId === "string"
      ? metadata.creativeRunItemId
      : null;
    const item = runItemId
      ? await tx.contentProductionItem.findFirst({
          where: {
            id: runItemId,
            batchId: run.id,
            mediaAssetId: placement.mediaAssetId,
          },
        })
      : null;
    if (!item || item.status !== "approved") {
      throw Errors.conflict("Staged placement lost its approved Creative Run item authority");
    }
    const rollbackTarget = await tx.mediaAssetPlacement.findFirst({
      where: {
        slot: placement.slot,
        targetType: placement.targetType,
        targetId: placement.targetId,
        status: "published",
        verificationState: "passed",
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    });
    if ((rollbackTarget?.id ?? null) !== placement.rollbackPlacementId) {
      throw Errors.conflict("The staged placement rollback authority changed before verification", {
        expectedRollbackPlacementId: placement.rollbackPlacementId,
        currentRollbackPlacementId: rollbackTarget?.id ?? null,
      });
    }
    const verifiedAt = new Date();
    const previousVisibility = placement.mediaAsset.visibility;
    const structurallyEligible =
      placement.slot === "campaign" &&
      placement.mediaAsset.deletedAt === null &&
      placement.mediaAsset.safetyStatus === "passed" &&
      placement.mediaAsset.type === "image";
    if (structurallyEligible && previousVisibility === "private") {
      await tx.mediaAsset.update({
        where: { id: placement.mediaAsset.id },
        data: { visibility: "unlisted" },
      });
    }
    if (structurallyEligible && rollbackTarget) {
      await tx.mediaAssetPlacement.update({
        where: { id: rollbackTarget.id },
        data: { status: "archived", archivedAt: verifiedAt, version: { increment: 1 } },
      });
    }
    if (structurallyEligible) {
      await tx.mediaAssetPlacement.update({
        where: { id: placement.id },
        data: {
          status: "published",
          publishedAt: verifiedAt,
          verificationState: "passed",
          verifiedAt,
          version: { increment: 1 },
        },
      });
    }
    const renderedCampaigns = structurallyEligible
      ? await resolveCommunityCampaignPlacements(tx)
      : [];
    const observed = renderedCampaigns.find((candidate) => candidate.id === placement.id) ?? null;
    const checks = {
      runtimeSurfaceSupported: placement.slot === "campaign",
      placementVisibleInRuntime: observed?.id === placement.id,
      renderedAssetMatches: observed?.mediaAssetId === placement.mediaAssetId,
      assetValid: Boolean(
        observed &&
        observed.mediaAsset.deletedAt === null &&
        observed.mediaAsset.safetyStatus === "passed",
      ),
    };
    const passed = Object.values(checks).every(Boolean);
    const placementVerificationState = passed ? "passed" : "failed";
    const projectedItemStatuses = (await tx.contentProductionItem.findMany({
      where: { batchId: run.id },
      select: { id: true, status: true },
      orderBy: { itemIndex: "asc" },
    })).map((candidate) => candidate.id === item.id && passed ? "published" : candidate.status);
    const continuation = passed
      ? deriveCreativeRunContinuation(projectedItemStatuses)
      : {
          lifecycleState: "active" as const,
          workflowStage: "placement" as const,
          verificationState: "failed" as const,
          status: "reviewing" as const,
        };
    if (
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, continuation.lifecycleState) ||
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, continuation.workflowStage) ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, continuation.verificationState) ||
      !isCreativePlacementVerificationTransitionAllowed(placement.verificationState, placementVerificationState)
    ) {
      throw Errors.conflict("Creative Run cannot accept the requested verification transition", {
        from: run.lifecycleState,
        to: continuation.lifecycleState,
        workflow: { from: run.workflowStage, to: continuation.workflowStage },
        runVerification: { from: run.verificationState, to: continuation.verificationState },
        placementVerification: { from: placement.verificationState, to: placementVerificationState },
      });
    }
    if (passed) {
      const itemUpdated = await tx.contentProductionItem.updateMany({
        where: {
          id: item.id,
          batchId: run.id,
          mediaAssetId: placement.mediaAssetId,
          status: "approved",
          version: item.version,
        },
        data: { status: "published", version: { increment: 1 } },
      });
      if (itemUpdated.count !== 1) {
        throw Errors.conflict("Creative Run item changed during placement verification");
      }
    } else {
      await tx.mediaAssetPlacement.update({
        where: { id: placement.id },
        data: {
          status: "archived",
          publishedAt: null,
          archivedAt: verifiedAt,
          verificationState: "failed",
          verifiedAt,
          version: { increment: structurallyEligible ? 0 : 1 },
        },
      });
      if (rollbackTarget && structurallyEligible) {
        await tx.mediaAssetPlacement.update({
          where: { id: rollbackTarget.id },
          data: { status: "published", archivedAt: null, version: { increment: 1 } },
        });
      }
      if (previousVisibility === "private" && structurallyEligible) {
        await tx.mediaAsset.update({
          where: { id: placement.mediaAsset.id },
          data: { visibility: "private" },
        });
      }
    }
    await tx.mediaAssetPlacement.update({
      where: { id: placement.id },
      data: {
        verificationEvidence: toInputJson({
          checks,
          resolver: placement.slot === "campaign" ? "community.campaigns.v1" : null,
          observedPlacementId: observed?.id ?? null,
          observedAssetId: observed?.mediaAssetId ?? null,
          observedAt: verifiedAt.toISOString(),
          rollbackPlacementId: rollbackTarget?.id ?? null,
          rollbackPreserved: !passed && Boolean(rollbackTarget),
        }),
      },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id },
      data: {
        workflowStage: continuation.workflowStage,
        verificationState: continuation.verificationState,
        lifecycleState: continuation.lifecycleState,
        status: continuation.status,
        version: { increment: 1 },
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.placement.verified",
        targetType: "media_asset_placement",
        targetId: placement.id,
        reason: input.reason,
        before: toInputJson({ verificationState: placement.verificationState, runVersion: run.version }),
        after: toInputJson({
          placementVerificationState,
          runVerificationState: continuation.verificationState,
          checks,
          runVersion: updatedRun.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: passed ? "creative.placement.verified.v2" : "creative.placement.verification_failed.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          placementId: placement.id,
          verificationState: placementVerificationState,
          runVerificationState: continuation.verificationState,
          checks,
          runVersion: updatedRun.version,
        }),
      },
    });
    return {
      runId: run.id,
      placementId: placement.id,
      verificationState: placementVerificationState,
      checks,
      runVersion: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}
