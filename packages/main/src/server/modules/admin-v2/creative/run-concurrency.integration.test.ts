import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { creativeReviewQualityPassed } from "@/server/modules/admin-v2/shared/creative-review-quality";
import { resolveCommunityCampaignPlacements } from "@/server/modules/ourdream/community-campaigns";
import {
  publishDistributionPlacement,
  verifyCreativePlacement,
  withdrawCreativePlacement,
} from "./placement";
import { recordCreativeReviewDecision } from "./review-decision";

describe("Creative workflow transition concurrency", () => {
  const suffix = randomUUID();
  const actor = {
    id: `creative-transition-actor-${suffix}`,
    role: "admin",
  } as const;
  const reviewAssetId = `creative-transition-review-asset-${suffix}`;
  const partialAssetId = `creative-transition-partial-asset-${suffix}`;
  const placementAssetId = `creative-transition-placement-asset-${suffix}`;
  const placementSiblingAssetId = `creative-transition-placement-sibling-asset-${suffix}`;
  const placementPreviousAssetId = `creative-transition-placement-previous-asset-${suffix}`;
  const placementPreviousId = `creative-transition-placement-previous-${suffix}`;
  const closedAssetId = `creative-transition-closed-asset-${suffix}`;
  const legacyReviewAssetId = `creative-transition-legacy-review-asset-${suffix}`;
  const terminalRejectAssetId = `creative-transition-terminal-reject-asset-${suffix}`;
  const supersededApprovedAssetId = `creative-transition-superseded-approved-asset-${suffix}`;
  const supersededRejectedAssetId = `creative-transition-superseded-rejected-asset-${suffix}`;
  const withdrawalAssetId = `creative-transition-withdrawal-asset-${suffix}`;
  const withdrawalPreviousAssetId = `creative-transition-withdrawal-previous-asset-${suffix}`;
  const placementJobId = `creative-transition-placement-job-${suffix}`;
  const supersededJobId = `creative-transition-superseded-job-${suffix}`;
  const withdrawalJobId = `creative-transition-withdrawal-job-${suffix}`;
  const reviewRunId = `creative-transition-review-${suffix}`;
  const reviewItemId = `creative-transition-review-item-${suffix}`;
  const partialRunId = `creative-transition-partial-${suffix}`;
  const partialItemId = `creative-transition-partial-item-${suffix}`;
  const partialPendingItemId = `creative-transition-partial-pending-item-${suffix}`;
  const placementRunId = `creative-transition-placement-${suffix}`;
  const placementItemId = `creative-transition-placement-item-${suffix}`;
  const placementSiblingItemId = `creative-transition-placement-sibling-item-${suffix}`;
  const placementTargetId = `creative-transition-placement-target-${suffix}`;
  const closedRunId = `creative-transition-closed-${suffix}`;
  const closedItemId = `creative-transition-closed-item-${suffix}`;
  const closedTargetId = `creative-transition-closed-target-${suffix}`;
  const closedPlacementId = `creative-transition-closed-placement-${suffix}`;
  const legacyReviewRunId = `creative-transition-legacy-review-${suffix}`;
  const legacyReviewItemId = `creative-transition-legacy-review-item-${suffix}`;
  const legacyReviewDecisionId = `creative-transition-legacy-review-decision-${suffix}`;
  const terminalRejectRunId = `creative-transition-terminal-reject-${suffix}`;
  const terminalRejectItemId = `creative-transition-terminal-reject-item-${suffix}`;
  const supersededRunId = `creative-transition-superseded-${suffix}`;
  const supersededItemId = `creative-transition-superseded-item-${suffix}`;
  const supersededTargetId = `creative-transition-superseded-target-${suffix}`;
  const withdrawalRunId = `creative-transition-withdrawal-${suffix}`;
  const withdrawalItemId = `creative-transition-withdrawal-item-${suffix}`;
  const withdrawalTargetId = `creative-transition-withdrawal-target-${suffix}`;
  const withdrawalDecisionId = `creative-transition-withdrawal-decision-${suffix}`;
  const withdrawalPreviousId = `creative-transition-withdrawal-previous-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actor.id,
        email: `${actor.id}@example.test`,
        role: actor.role,
        status: "active",
      },
    });
    await prisma.generationJob.createMany({
      data: [placementJobId, supersededJobId, withdrawalJobId].map((id) => ({
        id,
        userId: actor.id,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "comfyui",
      })),
    });
    await prisma.generationAttempt.createMany({
      data: [placementJobId, supersededJobId, withdrawalJobId].map((requestId) => ({
        id: `${requestId}-attempt`,
        requestId,
        attemptNo: 1,
        provider: "comfyui",
        status: "succeeded",
        finishedAt: new Date(),
      })),
    });
    await prisma.mediaAsset.createMany({
      data: [
        reviewAssetId,
        partialAssetId,
        placementAssetId,
        placementSiblingAssetId,
        closedAssetId,
        placementPreviousAssetId,
        legacyReviewAssetId,
        terminalRejectAssetId,
        supersededApprovedAssetId,
        supersededRejectedAssetId,
        withdrawalAssetId,
        withdrawalPreviousAssetId,
      ].map((id) => ({
        id,
        ownerId: actor.id,
        type: "image",
        url: `memory://${id}`,
        safetyStatus: "passed",
        visibility: id === placementPreviousAssetId ? "unlisted" : "private",
        metadata: {},
        sourceJobId: id === placementAssetId
          ? placementJobId
          : id === supersededApprovedAssetId
            ? supersededJobId
            : id === withdrawalAssetId
              ? withdrawalJobId
              : null,
      })),
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: partialRunId,
        title: "Partially generated Creative review",
        purpose: "model_eval",
        targetType: "none",
        presetIds: [],
        count: 2,
        totalItems: 2,
        completedItems: 1,
        status: "queued",
        lifecycleState: "active",
        workflowStage: "generation",
        verificationState: "pending",
        version: 1,
        createdById: actor.id,
        items: {
          create: [
            {
              id: partialItemId,
              itemIndex: 0,
              mediaAssetId: partialAssetId,
              status: "generated",
              tags: [],
            },
            {
              id: partialPendingItemId,
              itemIndex: 1,
              status: "queued",
              tags: [],
            },
          ],
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: reviewRunId,
        title: "Concurrent Creative review",
        purpose: "model_eval",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "pending",
        version: 1,
        createdById: actor.id,
        items: {
          create: {
            id: reviewItemId,
            itemIndex: 0,
            mediaAssetId: reviewAssetId,
            status: "generated",
            tags: [],
          },
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: placementRunId,
        title: "Concurrent Creative placement",
        purpose: "campaign",
        targetType: "campaign",
        targetId: placementTargetId,
        presetIds: [],
        count: 2,
        totalItems: 2,
        completedItems: 2,
        approvedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "placement",
        verificationState: "pending",
        version: 1,
        createdById: actor.id,
        items: {
          create: [{
            id: placementItemId,
            itemIndex: 0,
            mediaAssetId: placementAssetId,
            status: "approved",
            tags: [],
          }, {
            id: placementSiblingItemId,
            itemIndex: 1,
            mediaAssetId: placementSiblingAssetId,
            status: "generated",
            tags: [],
          }],
        },
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        runItemId: placementItemId,
        artifactId: placementAssetId,
        decision: "approved",
        identityConsistency: "passed",
        reason: "Approved before concurrent placement",
        reviewerId: actor.id,
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: withdrawalRunId,
        title: "Staged campaign withdrawal",
        purpose: "campaign",
        targetType: "campaign",
        targetId: withdrawalTargetId,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "placement",
        verificationState: "pending",
        version: 1,
        createdById: actor.id,
        items: {
          create: {
            id: withdrawalItemId,
            itemIndex: 0,
            mediaAssetId: withdrawalAssetId,
            status: "approved",
            tags: [],
          },
        },
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        id: withdrawalDecisionId,
        runItemId: withdrawalItemId,
        artifactId: withdrawalAssetId,
        decision: "approved",
        identityConsistency: "passed",
        reason: "Approved before staging the withdrawal fixture",
        reviewerId: actor.id,
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: withdrawalPreviousId,
        mediaAssetId: withdrawalPreviousAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: withdrawalTargetId,
        status: "published",
        verificationState: "passed",
        publishedAt: new Date(),
        verifiedAt: new Date(),
        createdById: actor.id,
        metadata: {
          fixture: "withdrawal-previous-live",
          eyebrow: "Featured",
          title: "Previous withdrawal campaign",
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: legacyReviewRunId,
        title: "Legacy Character review evidence repair",
        purpose: "model_eval",
        targetType: "character",
        targetId: `legacy-review-character-${suffix}`,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "placement",
        verificationState: "pending",
        version: 1,
        createdById: actor.id,
        items: {
          create: {
            id: legacyReviewItemId,
            itemIndex: 0,
            mediaAssetId: legacyReviewAssetId,
            status: "approved",
            tags: [],
          },
        },
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        id: legacyReviewDecisionId,
        runItemId: legacyReviewItemId,
        artifactId: legacyReviewAssetId,
        decision: "approved",
        identityConsistency: "passed",
        reason: "Legacy approval without structured visible evidence",
        evidence: {},
        reviewerId: actor.id,
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: placementPreviousId,
        mediaAssetId: placementPreviousAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: placementTargetId,
        status: "published",
        verificationState: "passed",
        publishedAt: new Date(),
        verifiedAt: new Date(),
        createdById: actor.id,
        metadata: {
          fixture: "previous-live-campaign",
          eyebrow: "Featured",
          title: "Previous live campaign",
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: terminalRejectRunId,
        title: "All-rejected Creative review",
        purpose: "model_eval",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "pending",
        version: 1,
        createdById: actor.id,
        items: {
          create: {
            id: terminalRejectItemId,
            itemIndex: 0,
            mediaAssetId: terminalRejectAssetId,
            status: "generated",
            tags: [],
          },
        },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: closedRunId,
        title: "Closed Creative placement",
        purpose: "feed",
        targetType: "campaign",
        targetId: closedTargetId,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "completed",
        lifecycleState: "closed",
        workflowStage: "verification",
        verificationState: "passed",
        version: 1,
        createdById: actor.id,
        items: {
          create: {
            id: closedItemId,
            itemIndex: 0,
            mediaAssetId: closedAssetId,
            status: "published",
            tags: [],
          },
        },
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        runItemId: closedItemId,
        artifactId: closedAssetId,
        decision: "approved",
        identityConsistency: "passed",
        reason: "Approved before the Run closed",
        reviewerId: actor.id,
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: closedPlacementId,
        mediaAssetId: closedAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: closedTargetId,
        status: "published",
        verificationState: "passed",
        publishedAt: new Date(),
        verifiedAt: new Date(),
        createdById: actor.id,
        metadata: { creativeRunId: closedRunId, creativeRunItemId: closedItemId },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: supersededRunId,
        title: "Superseded Creative review authority",
        purpose: "campaign",
        targetType: "campaign",
        targetId: supersededTargetId,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "placement",
        verificationState: "pending",
        version: 1,
        createdById: actor.id,
        items: {
          create: {
            id: supersededItemId,
            itemIndex: 0,
            mediaAssetId: supersededApprovedAssetId,
            status: "approved",
            tags: [],
          },
        },
      },
    });
    const supersededAt = new Date("2099-01-01T00:00:00.000Z");
    await prisma.creativeReviewDecision.createMany({
      data: [{
        id: `creative-transition-superseded-decision-a-${suffix}`,
        runItemId: supersededItemId,
        artifactId: supersededApprovedAssetId,
        decision: "approved",
        identityConsistency: "passed",
        reason: "Earlier approval for the previously selected artifact",
        reviewerId: actor.id,
        createdAt: supersededAt,
      }, {
        id: `creative-transition-superseded-decision-z-${suffix}`,
        runItemId: supersededItemId,
        artifactId: supersededRejectedAssetId,
        decision: "rejected",
        identityConsistency: "failed",
        reason: "Latest authority rejects the replacement artifact",
        reviewerId: actor.id,
        createdAt: supersededAt,
      }],
    });
  });

  afterAll(async () => {
    const runIds = [reviewRunId, partialRunId, placementRunId, closedRunId, legacyReviewRunId, terminalRejectRunId, supersededRunId, withdrawalRunId];
    const itemIds = [reviewItemId, partialItemId, partialPendingItemId, placementItemId, placementSiblingItemId, closedItemId, legacyReviewItemId, terminalRejectItemId, supersededItemId, withdrawalItemId];
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: actor.id } });
    await prisma.mediaAssetPlacement.deleteMany({
      where: { targetId: { in: [placementTargetId, closedTargetId, supersededTargetId, withdrawalTargetId, `legacy-review-target-${suffix}`] } },
    });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: { in: itemIds } } });
    await prisma.contentProductionItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: runIds } } });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: {
          in: [
            reviewAssetId,
            partialAssetId,
            placementAssetId,
            placementSiblingAssetId,
            closedAssetId,
            placementPreviousAssetId,
            legacyReviewAssetId,
            terminalRejectAssetId,
            supersededApprovedAssetId,
            supersededRejectedAssetId,
            withdrawalAssetId,
            withdrawalPreviousAssetId,
          ],
        },
      },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: [placementJobId, supersededJobId, withdrawalJobId] } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: [placementJobId, supersededJobId, withdrawalJobId] } },
    });
    await prisma.user.delete({ where: { id: actor.id } });
    await prisma.$disconnect();
  });

  it("rejects placement on a closed Run with zero domain, Audit, or Outbox effects", async () => {
    await expect(publishDistributionPlacement({
      runId: closedRunId,
      itemId: closedItemId,
      assetId: closedAssetId,
      actor,
      expectedVersion: 1,
      slot: "campaign",
      targetType: "campaign",
      targetId: closedTargetId,
      eyebrow: "Featured",
      title: "Closed campaign",
      reason: "A closed Run must not publish again",
      requestId: `closed-placement-${suffix}`,
    })).rejects.toThrow("Creative Run is not active for placement");

    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: closedRunId } })).resolves.toMatchObject({
      lifecycleState: "closed",
      workflowStage: "verification",
      verificationState: "passed",
      version: 1,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: closedItemId } })).resolves.toMatchObject({
      status: "published",
      version: 1,
    });
    await expect(prisma.mediaAssetPlacement.findMany({ where: { targetId: closedTargetId } })).resolves.toEqual([
      expect.objectContaining({ id: closedPlacementId, status: "published", version: 1 }),
    ]);
    await expect(prisma.adminAuditLog.count({ where: { requestId: `closed-placement-${suffix}` } })).resolves.toBe(0);
    await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: closedRunId } })).resolves.toBe(0);
  });

  it("places the exact generated artifact even when a historical review targeted another image", async () => {
    await expect(publishDistributionPlacement({
      runId: supersededRunId,
      itemId: supersededItemId,
      assetId: supersededApprovedAssetId,
      actor,
      expectedVersion: 1,
      slot: "campaign",
      targetType: "campaign",
      targetId: supersededTargetId,
      eyebrow: "Featured",
      title: "Superseded campaign",
      reason: "An older approval must not reappear after a newer decision",
      requestId: `superseded-placement-${suffix}`,
    })).resolves.toMatchObject({ verificationState: "verifying", runVersion: 2 });

    await expect(prisma.contentProductionBatch.findUniqueOrThrow({
      where: { id: supersededRunId },
    })).resolves.toMatchObject({
      workflowStage: "verification",
      verificationState: "verifying",
      version: 2,
    });
    await expect(prisma.mediaAssetPlacement.count({
      where: { targetId: supersededTargetId },
    })).resolves.toBe(1);
  });

  it("closes a Run immediately when review resolves its final item by rejection", async () => {
    await expect(recordCreativeReviewDecision({
      runId: terminalRejectRunId,
      itemId: terminalRejectItemId,
      actor,
      expectedVersion: 1,
      decision: "rejected",
      identityConsistency: "failed",
       score: 91,
      reason: "The final candidate does not meet the creative brief",
      requestId: `terminal-reject-${suffix}`,
    })).resolves.toMatchObject({
      workflowStage: "review",
      version: 2,
    });

    await expect(prisma.contentProductionBatch.findUniqueOrThrow({
      where: { id: terminalRejectRunId },
    })).resolves.toMatchObject({
      lifecycleState: "closed",
      workflowStage: "review",
      verificationState: "pending",
      status: "completed",
      version: 2,
    });
  });



  it("lets exactly one conflicting review commit for one expected Run and item version", async () => {
    const results = await Promise.allSettled([
      recordCreativeReviewDecision({
        runId: reviewRunId,
        itemId: reviewItemId,
        actor,
        expectedVersion: 1,
        decision: "approved",
        identityConsistency: "passed",
         score: 91,
        reason: "Approve from the first tab",
        requestId: `review-first-${suffix}`,
      }),
      recordCreativeReviewDecision({
        runId: reviewRunId,
        itemId: reviewItemId,
        actor,
        expectedVersion: 1,
        decision: "rejected",
        identityConsistency: "failed",
         score: 91,
        reason: "Reject from the second tab",
        requestId: `review-second-${suffix}`,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: reviewRunId } })).resolves.toMatchObject({
      lifecycleState: "closed",
      workflowStage: "review",
      verificationState: "pending",
      status: "completed",
      version: 2,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: reviewItemId } })).resolves.toMatchObject({
      version: 2,
    });
    await expect(prisma.creativeReviewDecision.count({ where: { runItemId: reviewItemId } })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: { targetId: reviewItemId, action: "creative.run.review_decided" },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: reviewRunId, eventType: "creative.review.decided.v2" },
    })).resolves.toBe(1);
  });

  it("allows a generated candidate to enter review while the rest of the Run is still generating", async () => {
    await expect(recordCreativeReviewDecision({
      runId: partialRunId,
      itemId: partialItemId,
      actor,
      expectedVersion: 1,
      decision: "approved",
      identityConsistency: "passed",
       score: 91,
      reason: "Approve the first ready candidate",
      requestId: `partial-review-${suffix}`,
    })).resolves.toMatchObject({
      workflowStage: "generation",
      version: 2,
    });

    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: partialRunId } })).resolves.toMatchObject({
      status: "reviewing",
      workflowStage: "generation",
      version: 2,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: partialItemId } })).resolves.toMatchObject({
      status: "approved",
      version: 2,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: partialPendingItemId } })).resolves.toMatchObject({
      status: "queued",
      version: 1,
    });
  });

  it("repairs legacy review evidence with one CAS-linked superseding decision", async () => {
    const repaired = await recordCreativeReviewDecision({
      runId: legacyReviewRunId,
      itemId: legacyReviewItemId,
      actor,
      expectedVersion: 1,
      supersedesDecisionId: legacyReviewDecisionId,
      decision: "approved",
      identityConsistency: "passed",
      score: 91,
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "Single intended subject with clean composition and no visible text",
      requestId: `legacy-review-repair-${suffix}`,
    });
    expect(repaired).toMatchObject({
      lifecycleState: "closed",
      workflowStage: "review",
      verificationState: "pending",
      version: 2,
    });

    const decisions = await prisma.creativeReviewDecision.findMany({
      where: { runItemId: legacyReviewItemId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(decisions).toHaveLength(2);
    expect(decisions.find((decision) => decision.id === legacyReviewDecisionId)?.evidence).toEqual({});
    const latest = decisions.find((decision) => decision.id !== legacyReviewDecisionId);
    expect(latest).toMatchObject({
      supersedesDecisionId: legacyReviewDecisionId,
      decision: "approved",
       score: 91,
      evidence: {
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
      },
    });
    expect(creativeReviewQualityPassed(latest?.evidence)).toBe(true);

    await prisma.contentProductionBatch.update({
      where: { id: legacyReviewRunId },
      data: {
        lifecycleState: "active",
        status: "reviewing",
      },
    });
    await expect(recordCreativeReviewDecision({
      runId: legacyReviewRunId,
      itemId: legacyReviewItemId,
      actor,
      expectedVersion: 2,
      supersedesDecisionId: legacyReviewDecisionId,
      decision: "rejected",
      identityConsistency: "failed",
       score: 91,
      quality: {
        artifactFree: false,
        singleSubject: true,
        intentMatch: false,
        noVisibleText: true,
      },
      reason: "A stale reviewer must not overwrite the current review authority",
      requestId: `legacy-review-stale-${suffix}`,
    })).rejects.toThrow("Creative review authority changed");

    await prisma.mediaAssetPlacement.create({
      data: {
        mediaAssetId: legacyReviewAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `legacy-review-target-${suffix}`,
        status: "published",
        verificationState: "pending",
        publishedAt: new Date(),
        createdById: actor.id,
        metadata: {},
      },
    });
    await expect(recordCreativeReviewDecision({
      runId: legacyReviewRunId,
      itemId: legacyReviewItemId,
      actor,
      expectedVersion: 2,
      supersedesDecisionId: latest!.id,
      decision: "rejected",
      identityConsistency: "failed",
       score: 91,
      quality: {
        artifactFree: false,
        singleSubject: true,
        intentMatch: false,
        noVisibleText: true,
      },
      reason: "A staged placement must be withdrawn before review authority changes",
      requestId: `legacy-review-placement-guard-${suffix}`,
    })).rejects.toThrow("must be withdrawn");
  });

  it("withdraws one staged campaign candidate without fabricating a new review", async () => {
    const staged = await publishDistributionPlacement({
      runId: withdrawalRunId,
      itemId: withdrawalItemId,
      assetId: withdrawalAssetId,
      actor,
      expectedVersion: 1,
      slot: "campaign",
      targetType: "campaign",
      targetId: withdrawalTargetId,
      eyebrow: "Featured",
      title: "Withdrawal campaign",
      reason: "Stage the approved withdrawal fixture without replacing live media yet",
      requestId: `withdrawal-stage-${suffix}`,
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: staged.placementId },
    })).resolves.toMatchObject({
      status: "scheduled",
      verificationState: "verifying",
      rollbackPlacementId: withdrawalPreviousId,
    });

    await expect(recordCreativeReviewDecision({
      runId: withdrawalRunId,
      itemId: withdrawalItemId,
      actor,
      expectedVersion: 2,
      supersedesDecisionId: withdrawalDecisionId,
      decision: "rejected",
      identityConsistency: "failed",
      reason: "The staged placement must be withdrawn before review authority changes",
      requestId: `withdrawal-review-guard-${suffix}`,
    })).rejects.toMatchObject({ status: 409, details: { code: "manual_asset_review_retired" } });
    await expect(prisma.creativeReviewDecision.count({
      where: { runItemId: withdrawalItemId },
    })).resolves.toBe(1);

    const withdrawals = await Promise.allSettled([
      withdrawCreativePlacement({
        runId: withdrawalRunId,
        placementId: staged.placementId,
        actor,
        expectedVersion: 2,
        reason: "Withdraw the staged candidate after the final visual review",
        requestId: `withdrawal-first-${suffix}`,
      }),
      withdrawCreativePlacement({
        runId: withdrawalRunId,
        placementId: staged.placementId,
        actor,
        expectedVersion: 2,
        reason: "A concurrent operator must not withdraw the same candidate twice",
        requestId: `withdrawal-second-${suffix}`,
      }),
    ]);
    expect(withdrawals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(withdrawals.filter((result) => result.status === "rejected")).toHaveLength(1);
    const withdrawal = withdrawals.find((result) => result.status === "fulfilled");
    expect(withdrawal).toMatchObject({
      status: "fulfilled",
      value: {
        placementId: staged.placementId,
        verificationState: "overridden",
        runVersion: 3,
      },
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: staged.placementId },
    })).resolves.toMatchObject({
      status: "archived",
      verificationState: "overridden",
      rollbackPlacementId: withdrawalPreviousId,
      verificationEvidence: {
        disposition: "operator_withdrawn",
        rollbackPlacementId: withdrawalPreviousId,
      },
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: withdrawalPreviousId },
    })).resolves.toMatchObject({
      status: "published",
      verificationState: "passed",
    });
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({
      where: { id: withdrawalRunId },
    })).resolves.toMatchObject({
      lifecycleState: "active",
      workflowStage: "placement",
      verificationState: "pending",
      version: 3,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({
      where: { id: withdrawalItemId },
    })).resolves.toMatchObject({ status: "approved" });
    await expect(prisma.adminAuditLog.count({
      where: { action: "creative.placement.withdrawn", targetId: staged.placementId },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { eventType: "creative.placement.withdrawn.v2", aggregateId: withdrawalRunId },
    })).resolves.toBe(1);

    expect(await prisma.creativeReviewDecision.count({ where: { runItemId: withdrawalItemId } })).toBe(1);
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: withdrawalRunId } }))
      .resolves.toMatchObject({ version: 3, lifecycleState: "active", workflowStage: "placement" });
  });

  it("lets exactly one concurrent placement commit for one expected Run and item version", async () => {
    const place = (requestId: string) => publishDistributionPlacement({
      runId: placementRunId,
      itemId: placementItemId,
      assetId: placementAssetId,
      actor,
      expectedVersion: 1,
      slot: "campaign",
      targetType: "campaign",
      targetId: placementTargetId,
      eyebrow: "Featured",
      title: "Concurrent campaign",
      reason: "Publish the approved campaign asset",
      requestId,
    });
    const results = await Promise.allSettled([
      place(`placement-first-${suffix}`),
      place(`placement-second-${suffix}`),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: placementRunId } })).resolves.toMatchObject({
      lifecycleState: "active",
      workflowStage: "verification",
      verificationState: "verifying",
      version: 2,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: placementItemId } })).resolves.toMatchObject({
      status: "approved",
      version: 2,
    });
    await expect(prisma.mediaAssetPlacement.count({
      where: { targetId: placementTargetId, status: "scheduled", verificationState: "verifying" },
    })).resolves.toBe(1);
    const pendingPublishedPlacement = await prisma.mediaAssetPlacement.create({
      data: {
        mediaAssetId: placementSiblingAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: placementTargetId,
        status: "published",
        verificationState: "pending",
        publishedAt: new Date(),
        createdById: actor.id,
        metadata: { fixture: "must-never-serve-without-verification" },
      },
    });
    await expect(resolveCommunityCampaignPlacements(prisma)).resolves.toContainEqual(
      expect.objectContaining({ id: placementPreviousId, mediaAssetId: placementPreviousAssetId }),
    );
    await expect(resolveCommunityCampaignPlacements(prisma)).resolves.not.toContainEqual(
      expect.objectContaining({ id: pendingPublishedPlacement.id }),
    );
    await expect(prisma.adminAuditLog.count({
      where: { action: "creative.placement.staged", requestId: { in: [`placement-first-${suffix}`, `placement-second-${suffix}`] } },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: placementRunId, eventType: "creative.placement.verification_requested.v2" },
    })).resolves.toBe(1);

    const staged = await prisma.mediaAssetPlacement.findFirstOrThrow({
      where: { targetId: placementTargetId, status: "scheduled" },
    });
    await prisma.mediaAsset.update({
      where: { id: placementAssetId },
      data: { safetyStatus: "blocked" },
    });
    await expect(verifyCreativePlacement({
      runId: placementRunId,
      placementId: staged.id,
      actor,
      expectedVersion: 2,
      reason: "Reject the staged asset after runtime eligibility changed",
      requestId: `placement-verification-failed-${suffix}`,
    })).resolves.toMatchObject({
      verificationState: "failed",
      runVersion: 3,
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: staged.id } })).resolves.toMatchObject({
      status: "archived",
      verificationState: "failed",
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: placementPreviousId } })).resolves.toMatchObject({
      status: "published",
      verificationState: "passed",
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: placementItemId } })).resolves.toMatchObject({
      status: "approved",
    });
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: placementRunId } })).resolves.toMatchObject({
      lifecycleState: "active",
      workflowStage: "placement",
      verificationState: "failed",
      version: 3,
    });
    await expect(resolveCommunityCampaignPlacements(prisma)).resolves.toContainEqual(
      expect.objectContaining({ id: placementPreviousId, mediaAssetId: placementPreviousAssetId }),
    );

    await prisma.mediaAsset.update({
      where: { id: placementAssetId },
      data: { safetyStatus: "passed" },
    });
    const restaged = await publishDistributionPlacement({
      runId: placementRunId,
      itemId: placementItemId,
      assetId: placementAssetId,
      actor,
      expectedVersion: 3,
      slot: "campaign",
      targetType: "campaign",
      targetId: placementTargetId,
      eyebrow: "Featured",
      title: "Restaged campaign",
      reason: "Retry the verified campaign placement after the asset recovered",
      requestId: `placement-restaged-${suffix}`,
    });
    const verified = await verifyCreativePlacement({
      runId: placementRunId,
      placementId: restaged.placementId,
      actor,
      expectedVersion: 4,
      reason: "Verify one winner while another generated candidate remains available for placement",
      requestId: `placement-verification-passed-${suffix}`,
    });
    expect(verified.verificationState).toBe("passed");
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: placementRunId } })).resolves.toMatchObject({
      lifecycleState: "active",
      workflowStage: "placement",
      verificationState: "pending",
      status: "reviewing",
      version: 5,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: placementItemId } })).resolves.toMatchObject({
      status: "published",
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: placementSiblingItemId } })).resolves.toMatchObject({
      status: "generated",
    });
  });
});
