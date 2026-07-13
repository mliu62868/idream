import { prisma } from "@/server/lib/db";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { deriveCreativeRunState, type CreativeRunLedgerFact } from "@/server/modules/admin/content-production-state";
import { toInputJson } from "../shared/prisma-json";
import {
  isCreativePlacementVerificationTransitionAllowed,
  isCreativeRunItemTransitionAllowed,
  isCreativeRunLifecycleTransitionAllowed,
  isCreativeRunVerificationTransitionAllowed,
  isCreativeRunWorkflowTransitionAllowed,
} from "../shared/state-transition-authority";
import { resolveCommunityCampaignPlacements } from "@/server/modules/ourdream/community-campaigns";
import {
  creativeRunListResponseSchema,
  creativeRunQuerySchema,
} from "@idream/shared/admin";

const RELEASE_OWNED_SLOTS = new Set(["character_avatar", "character_hero"]);

function latestByCreatedAt<T extends { createdAt: Date }>(rows: readonly T[]): T | null {
  return [...rows].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function attachCreativeRunToIncident(input: {
  readonly runId: string;
  readonly incidentId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findUnique({
      where: { id: input.runId },
      include: { items: { select: { jobId: true } } },
    });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before Incident attachment", { currentVersion: run.version });
    }
    const incident = await tx.opsIncident.findUnique({ where: { id: input.incidentId } });
    if (!incident || ["resolved", "closed"].includes(incident.status)) {
      throw Errors.conflict("Only an active Incident can receive Creative Run occurrences");
    }
    const requestIds = run.items.flatMap((item) => item.jobId ? [item.jobId] : []);
    const attempts = await tx.generationAttempt.findMany({
      where: { requestId: { in: requestIds }, status: { in: ["failed", "unknown"] } },
      orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
    });
    const latestAttempts = [...new Map(attempts.map((attempt) => [attempt.requestId, attempt])).values()];
    if (latestAttempts.length === 0) {
      throw Errors.conflict("Creative Run has no failed or unknown Attempt to attach");
    }
    const existing = await tx.opsIncidentOccurrence.findMany({
      where: { attemptId: { in: latestAttempts.map((attempt) => attempt.id) } },
    });
    const conflicting = existing.find((occurrence) => occurrence.incidentId !== incident.id);
    if (conflicting) {
      throw Errors.conflict("A Creative failure already belongs to another Incident", {
        occurrenceId: conflicting.id,
        incidentId: conflicting.incidentId,
        deepLink: `/admin/ops/incidents/${conflicting.incidentId}`,
      });
    }
    const attachedAttemptIds = new Set(existing.map((occurrence) => occurrence.attemptId));
    const toCreate = latestAttempts.filter((attempt) => !attachedAttemptIds.has(attempt.id));
    if (toCreate.length > 0) {
      await tx.opsIncidentOccurrence.createMany({
        data: toCreate.map((attempt) => ({
          incidentId: incident.id,
          requestId: attempt.requestId,
          attemptId: attempt.id,
          occurrenceKey: `creative_manual:${run.id}:${attempt.id}`,
          observedAt: attempt.finishedAt ?? attempt.createdAt,
        })),
      });
    }
    const now = new Date();
    const impact = record(incident.impact);
    const creativeRunIds = Array.isArray(impact.creativeRunIds)
      ? impact.creativeRunIds.filter((value): value is string => typeof value === "string")
      : [];
    const updatedIncident = await tx.opsIncident.update({
      where: { id: incident.id },
      data: {
        impact: toInputJson({ ...impact, creativeRunIds: [...new Set([...creativeRunIds, run.id])] }),
        lastSeen: now,
        version: { increment: 1 },
      },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id },
      data: { version: { increment: 1 } },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.run.incident_attached",
        targetType: "creative_run",
        targetId: run.id,
        reason: input.reason,
        after: toInputJson({
          incidentId: incident.id,
          occurrenceCount: latestAttempts.length,
          createdOccurrenceCount: toCreate.length,
          runVersion: updatedRun.version,
          incidentVersion: updatedIncident.version,
        }),
        requestId: input.requestId,
      },
    });
    await tx.mainOutboxEvent.create({
      data: {
        eventType: "creative.run.incident_attached.v2",
        aggregateType: "creative_run",
        aggregateId: run.id,
        payload: toInputJson({
          runId: run.id,
          incidentId: incident.id,
          attemptIds: latestAttempts.map((attempt) => attempt.id),
          runVersion: updatedRun.version,
          incidentVersion: updatedIncident.version,
        }),
      },
    });
    return {
      runId: run.id,
      incidentId: incident.id,
      relatedAttemptIds: latestAttempts.map((attempt) => attempt.id),
      runVersion: updatedRun.version,
      incidentVersion: updatedIncident.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

async function ledgerFacts(jobIds: readonly string[]): Promise<CreativeRunLedgerFact[]> {
  if (jobIds.length === 0) return [];
  return prisma.dreamcoinLedger.findMany({
    where: { sourceId: { in: [...jobIds] }, reason: { in: ["generation_spend", "refund"] } },
    select: { sourceId: true, reason: true, delta: true },
  });
}

export async function recordCreativeReviewDecision(input: {
  readonly runId: string;
  readonly itemId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly decision: "approved" | "rejected";
  readonly identityConsistency: "passed" | "failed" | "unscored";
  readonly score?: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  if (input.reason.trim().length < 3) throw Errors.badRequest("Review reason is required");
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findUnique({ where: { id: input.runId } });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before review", { currentVersion: run.version });
    }
    if (
      run.lifecycleState !== "active" ||
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, run.lifecycleState)
    ) {
      throw Errors.conflict("Creative Run is not active for review", { lifecycleState: run.lifecycleState });
    }
    const nextWorkflowStage = input.decision === "approved" ? "placement" : "review";
    if (
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, nextWorkflowStage) ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, "pending")
    ) {
      throw Errors.conflict("Creative Run cannot accept the requested review transition", {
        workflow: { from: run.workflowStage, to: nextWorkflowStage },
        verification: { from: run.verificationState, to: "pending" },
      });
    }
    const item = await tx.contentProductionItem.findFirst({
      where: { id: input.itemId, batchId: run.id },
      include: { mediaAsset: true, job: { include: { assets: { orderBy: { createdAt: "asc" } } } } },
    });
    if (!item) throw Errors.notFound("Creative Run item not found");
    if (!isCreativeRunItemTransitionAllowed(item.status, input.decision)) {
      throw Errors.conflict("Creative Run item cannot enter the requested review state", {
        from: item.status,
        to: input.decision,
      });
    }
    const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
    if (!asset || asset.deletedAt || asset.safetyStatus !== "passed") {
      throw Errors.badRequest("Only a valid generated asset can be reviewed");
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
        workflowStage: nextWorkflowStage,
        verificationState: "pending",
        status: "reviewing",
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
        decision: input.decision,
        identityConsistency: input.identityConsistency,
        score: input.score,
        reason: input.reason.trim(),
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
          decision: decision.decision,
          identityConsistency: decision.identityConsistency,
          score: decision.score,
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
      workflowStage: updatedRun.workflowStage,
      version: updatedRun.version,
    };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function publishDistributionPlacement(input: {
  readonly runId: string;
  readonly itemId: string;
  readonly assetId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly slot: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  if (RELEASE_OWNED_SLOTS.has(input.slot)) {
    throw Errors.forbidden("Release-owned placements require a Character Release patch and publish command", {
      code: "release_owned_placement_requires_release_patch",
      slot: input.slot,
    });
  }
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findUnique({ where: { id: input.runId } });
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
    const latestReview = await tx.creativeReviewDecision.findFirst({
      where: { runItemId: item.id, artifactId: input.assetId },
      orderBy: { createdAt: "desc" },
    });
    if (!latestReview || latestReview.decision !== "approved") {
      throw Errors.badRequest("An approved immutable review decision is required before placement");
    }
    const rollbackTarget = await tx.mediaAssetPlacement.findFirst({
      where: {
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "published",
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    });
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
      data: { status: "published", version: { increment: 1 } },
    });
    if (claimedItem.count !== 1) {
      throw Errors.conflict("Creative Run item changed during placement", {
        itemId: item.id,
        expectedVersion: item.version,
      });
    }
    if (rollbackTarget) {
      await tx.mediaAssetPlacement.update({
        where: { id: rollbackTarget.id },
        data: { status: "archived", archivedAt: new Date(), version: { increment: 1 } },
      });
    }
    const placement = await tx.mediaAssetPlacement.create({
      data: {
        mediaAssetId: input.assetId,
        slot: input.slot,
        targetType: input.targetType,
        targetId: input.targetId,
        status: "published",
        publishedAt: new Date(),
        createdById: input.actor.id,
        metadata: toInputJson({ creativeRunId: run.id, creativeRunItemId: item.id }),
        verificationState: "verifying",
        rollbackPlacementId: rollbackTarget?.id,
      },
    });
    if (placement.slot === "campaign" && item.mediaAsset.visibility === "private") {
      await tx.mediaAsset.update({
        where: { id: item.mediaAsset.id },
        data: { visibility: "unlisted" },
      });
    }
    const updatedRun = await tx.contentProductionBatch.findUniqueOrThrow({
      where: { id: run.id },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "creative.placement.published",
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

export async function verifyCreativePlacement(input: {
  readonly runId: string;
  readonly placementId: string;
  readonly actor: AdminActor;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly requestId: string;
}, db?: Prisma.TransactionClient) {
  const execute = async (tx: Prisma.TransactionClient) => {
    const run = await tx.contentProductionBatch.findUnique({ where: { id: input.runId } });
    if (!run) throw Errors.notFound("Creative Run not found");
    if (run.version !== input.expectedVersion) {
      throw Errors.conflict("Creative Run changed before placement verification", { currentVersion: run.version });
    }
    const placement = await tx.mediaAssetPlacement.findUnique({
      where: { id: input.placementId },
      include: { mediaAsset: true },
    });
    if (!placement) throw Errors.notFound("Creative placement not found");
    const metadata = placement.metadata as Record<string, unknown>;
    if (metadata.creativeRunId !== run.id) throw Errors.notFound("Placement does not belong to Creative Run");
    const renderedCampaigns = placement.slot === "campaign"
      ? await resolveCommunityCampaignPlacements(tx)
      : [];
    const observed = renderedCampaigns.find((candidate) => candidate.id === placement.id) ?? null;
    const checks = {
      runtimeSurfaceSupported: placement.slot === "campaign",
      placementVisibleInRuntime: observed?.id === placement.id,
      renderedAssetMatches: observed?.mediaAssetId === placement.mediaAssetId,
      assetValid: !observed?.mediaAsset.deletedAt && observed?.mediaAsset.safetyStatus === "passed",
    };
    const passed = Object.values(checks).every(Boolean);
    const verificationState = passed ? "passed" : "failed";
    const nextLifecycleState = passed ? "closed" : "active";
    if (
      !isCreativeRunLifecycleTransitionAllowed(run.lifecycleState, nextLifecycleState) ||
      !isCreativeRunWorkflowTransitionAllowed(run.workflowStage, "verification") ||
      !isCreativeRunVerificationTransitionAllowed(run.verificationState, verificationState) ||
      !isCreativePlacementVerificationTransitionAllowed(placement.verificationState, verificationState)
    ) {
      throw Errors.conflict("Creative Run cannot accept the requested verification transition", {
        from: run.lifecycleState,
        to: nextLifecycleState,
        workflow: { from: run.workflowStage, to: "verification" },
        runVerification: { from: run.verificationState, to: verificationState },
        placementVerification: { from: placement.verificationState, to: verificationState },
      });
    }
    const verifiedAt = new Date();
    await tx.mediaAssetPlacement.update({
      where: { id: placement.id },
      data: {
        verificationState,
        verificationEvidence: toInputJson({
          checks,
          resolver: placement.slot === "campaign" ? "community.campaigns.v1" : null,
          observedPlacementId: observed?.id ?? null,
          observedAssetId: observed?.mediaAssetId ?? null,
          observedAt: verifiedAt.toISOString(),
        }),
        verifiedAt,
        version: { increment: 1 },
      },
    });
    const updatedRun = await tx.contentProductionBatch.update({
      where: { id: run.id },
      data: {
        workflowStage: "verification",
        verificationState,
        lifecycleState: nextLifecycleState,
        status: passed ? "completed" : "reviewing",
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
        after: toInputJson({ verificationState, checks, runVersion: updatedRun.version }),
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
          verificationState,
          checks,
          runVersion: updatedRun.version,
        }),
      },
    });
    return { runId: run.id, placementId: placement.id, verificationState, checks, runVersion: updatedRun.version };
  };
  return db ? execute(db) : prisma.$transaction(execute);
}

export async function listCreativeRuns(input: {
  readonly requestUrl: string;
  readonly actor: AdminActor;
}) {
  void input.actor;
  const query = creativeRunQuerySchema.parse(Object.fromEntries(new URL(input.requestUrl).searchParams));
  const summaries: Array<ReturnType<typeof deriveCreativeRunSummary>> = [];
  const batchSize = Math.min(200, Math.max(50, query.limit * 4));
  let scanCursor = query.cursor;
  let exhausted = false;

  while (summaries.length <= query.limit && !exhausted) {
    const roots = await prisma.contentProductionBatch.findMany({
      where: {
        id: scanCursor ? { gt: scanCursor } : undefined,
        lifecycleState: query.lifecycleState,
        workflowStage: query.workflowStage,
        ownerId: query.ownerId,
        priority: query.priority,
        ...(query.search ? {
          OR: [
            { id: { contains: query.search, mode: "insensitive" } },
            { title: { contains: query.search, mode: "insensitive" } },
            { purpose: { contains: query.search, mode: "insensitive" } },
          ],
        } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      include: {
        items: {
          include: {
            job: { include: { assets: { include: { placements: true } } } },
            mediaAsset: { include: { placements: true } },
          },
          orderBy: { itemIndex: "asc" },
        },
      },
    });
    if (roots.length === 0) {
      exhausted = true;
      break;
    }
    const allJobIds = roots.flatMap((run) => run.items.flatMap((item) => item.jobId ? [item.jobId] : []));
    const allLedgerFacts = await ledgerFacts(allJobIds);
    for (const run of roots) {
      const summary = deriveCreativeRunSummary(run, allLedgerFacts);
      if (!query.executionOutcome || summary.executionOutcome === query.executionOutcome) {
        summaries.push(summary);
      }
    }
    scanCursor = roots.at(-1)?.id;
    exhausted = roots.length < batchSize;
  }

  const page = summaries.slice(0, query.limit);
  const hasNextPage = summaries.length > query.limit || !exhausted;
  return creativeRunListResponseSchema.parse({
    items: page,
    pageInfo: {
      endCursor: hasNextPage ? page.at(-1)?.id ?? scanCursor ?? null : null,
      hasNextPage,
    },
    asOf: new Date().toISOString(),
    freshness: "fresh",
  });
}

type CreativeRunRoot = Prisma.ContentProductionBatchGetPayload<{
  include: {
    items: {
      include: {
        job: { include: { assets: { include: { placements: true } } } };
        mediaAsset: { include: { placements: true } };
      };
    };
  };
}>;

function deriveCreativeRunSummary(
  run: CreativeRunRoot,
  allLedgerFacts: readonly CreativeRunLedgerFact[],
) {
  const jobIds = new Set(run.items.flatMap((item) => item.jobId ? [item.jobId] : []));
  const state = deriveCreativeRunState({
    legacyStatus: run.status,
    expectedItemCount: run.totalItems,
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job ? {
          id: item.job.id,
          status: item.job.status,
          errorCode: item.job.errorCode,
          costDreamcoins: item.job.costDreamcoins,
        } : null,
        asset: asset ? { id: asset.id, safetyStatus: asset.safetyStatus, deletedAt: asset.deletedAt } : null,
        placements: asset?.placements.map((placement) => ({
          status: placement.status,
          verificationState: placement.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
        })) ?? [],
      };
    }),
    ledgerEntries: allLedgerFacts.filter((fact) => fact.sourceId !== null && jobIds.has(fact.sourceId)),
  });
  return {
    id: run.id,
    purpose: run.purpose,
    target: { type: run.targetType, id: run.targetId ?? run.id },
    ownerId: run.ownerId,
    dueAt: run.dueAt?.toISOString() ?? null,
    priority: run.priority,
    lifecycleState: run.lifecycleState,
    workflowStage: run.workflowStage,
    executionOutcome: state.executionOutcome,
    reviewState: state.reviewState,
    deploymentState: state.deploymentState,
    counts: state.counts,
    verificationState: run.verificationState === "failed" ? "failed" as const : state.verificationState,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export async function getCreativeRunDetail(input: {
  readonly runId: string;
  readonly actor: AdminActor;
}) {
  void input.actor;
  const run = await prisma.contentProductionBatch.findUnique({
    where: { id: input.runId },
    include: {
      items: {
        include: {
          job: { include: { assets: { include: { placements: true } } } },
          mediaAsset: { include: { placements: true } },
        },
        orderBy: { itemIndex: "asc" },
      },
    },
  });
  if (!run) throw Errors.notFound("Creative Run not found");
  const itemIds = run.items.map((item) => item.id);
  const jobIds = run.items.flatMap((item) => item.jobId ? [item.jobId] : []);
  const [decisions, attempts, ledgerEntries] = await Promise.all([
    prisma.creativeReviewDecision.findMany({ where: { runItemId: { in: itemIds } }, orderBy: { createdAt: "desc" } }),
    prisma.generationAttempt.findMany({ where: { requestId: { in: jobIds } }, orderBy: { attemptNo: "desc" } }),
    ledgerFacts(jobIds),
  ]);
  const state = deriveCreativeRunState({
    legacyStatus: run.status,
    expectedItemCount: run.totalItems,
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      return {
        id: item.id,
        status: item.status,
        job: item.job ? { id: item.job.id, status: item.job.status, errorCode: item.job.errorCode, costDreamcoins: item.job.costDreamcoins } : null,
        asset: asset ? { id: asset.id, safetyStatus: asset.safetyStatus, deletedAt: asset.deletedAt } : null,
        placements: asset?.placements.map((placement) => ({
          status: placement.status,
          verificationState: placement.verificationState as "pending" | "verifying" | "passed" | "failed" | "overridden",
        })) ?? [],
      };
    }),
    ledgerEntries,
  });
  const relatedIncidentIds = [...new Set((await prisma.opsIncidentOccurrence.findMany({
    where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
    select: { incidentId: true },
  })).map((occurrence) => occurrence.incidentId))];
  return {
    id: run.id,
    title: run.title,
    purpose: run.purpose,
    target: { type: run.targetType, id: run.targetId ?? run.id },
    ownerId: run.ownerId,
    dueAt: run.dueAt?.toISOString() ?? null,
    priority: run.priority,
    lifecycleState: run.lifecycleState,
    workflowStage: run.workflowStage,
    ...state,
    verificationState: run.verificationState === "failed" ? "failed" : state.verificationState,
    relatedIncidentIds,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    items: run.items.map((item) => {
      const asset = item.mediaAsset ?? item.job?.assets[0] ?? null;
      const latestDecision = latestByCreatedAt(decisions.filter((decision) => decision.runItemId === item.id));
      const latestAttempt = attempts.find((attempt) => attempt.requestId === item.jobId) ?? null;
      const placement = asset
        ? latestByCreatedAt(asset.placements.filter((candidate) => candidate.status === "published"))
        : null;
      return {
        id: item.id,
        ordinal: item.itemIndex,
        status: item.status,
        version: item.version,
        retryability: latestAttempt?.retryability ?? (item.status === "failed" ? "unknown" : "not_applicable"),
        lineage: {
          briefId: run.id,
          directionId: item.directionId,
          directionHash: item.directionHash,
          generationProfileKey: run.profileId,
          generationProfileVersion: run.profileVersion === null ? null : String(run.profileVersion),
          workflowKey: latestAttempt?.workflowKey ?? null,
          workflowVersion: latestAttempt?.workflowVersion === null || latestAttempt?.workflowVersion === undefined
            ? null
            : String(latestAttempt.workflowVersion),
          requestId: item.jobId,
          attemptId: latestAttempt?.id ?? null,
          assetId: asset?.id ?? null,
          reviewDecisionId: latestDecision?.id ?? null,
          placementVersionId: placement?.id ?? null,
        },
        asset: asset ? {
          id: asset.id,
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl,
          width: asset.width,
          height: asset.height,
        } : null,
        review: latestDecision
          ? {
              id: latestDecision.id,
              decision: latestDecision.decision,
              identityConsistency: latestDecision.identityConsistency,
              score: latestDecision.score,
              reason: latestDecision.reason,
              reviewerId: latestDecision.reviewerId,
              createdAt: latestDecision.createdAt.toISOString(),
            }
          : null,
        placement: placement
          ? {
              id: placement.id,
              slot: placement.slot,
              targetType: placement.targetType,
              targetId: placement.targetId,
              status: placement.status,
              verificationState: placement.verificationState,
              verifiedAt: placement.verifiedAt?.toISOString() ?? null,
              rollbackPlacementId: placement.rollbackPlacementId,
            }
          : null,
      };
    }),
  };
}
