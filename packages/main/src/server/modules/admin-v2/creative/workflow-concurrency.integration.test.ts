import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  publishDistributionPlacement,
  recordCreativeReviewDecision,
} from "./workflow";

describe("Creative workflow transition concurrency", () => {
  const suffix = randomUUID();
  const actor = {
    id: `creative-transition-actor-${suffix}`,
    role: "admin",
  } as const;
  const reviewAssetId = `creative-transition-review-asset-${suffix}`;
  const placementAssetId = `creative-transition-placement-asset-${suffix}`;
  const closedAssetId = `creative-transition-closed-asset-${suffix}`;
  const reviewRunId = `creative-transition-review-${suffix}`;
  const reviewItemId = `creative-transition-review-item-${suffix}`;
  const placementRunId = `creative-transition-placement-${suffix}`;
  const placementItemId = `creative-transition-placement-item-${suffix}`;
  const placementTargetId = `creative-transition-placement-target-${suffix}`;
  const closedRunId = `creative-transition-closed-${suffix}`;
  const closedItemId = `creative-transition-closed-item-${suffix}`;
  const closedTargetId = `creative-transition-closed-target-${suffix}`;
  const closedPlacementId = `creative-transition-closed-placement-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actor.id,
        email: `${actor.id}@example.test`,
        role: actor.role,
        status: "active",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [reviewAssetId, placementAssetId, closedAssetId].map((id) => ({
        id,
        ownerId: actor.id,
        type: "image",
        url: `memory://${id}`,
        safetyStatus: "passed",
        metadata: {},
      })),
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: reviewRunId,
        title: "Concurrent Creative review",
        purpose: "feed",
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
        purpose: "feed",
        targetType: "campaign",
        targetId: placementTargetId,
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
            id: placementItemId,
            itemIndex: 0,
            mediaAssetId: placementAssetId,
            status: "approved",
            tags: [],
          },
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
  });

  afterAll(async () => {
    const runIds = [reviewRunId, placementRunId, closedRunId];
    const itemIds = [reviewItemId, placementItemId, closedItemId];
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: actor.id } });
    await prisma.mediaAssetPlacement.deleteMany({
      where: { targetId: { in: [placementTargetId, closedTargetId] } },
    });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: { in: itemIds } } });
    await prisma.contentProductionItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: runIds } } });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: [reviewAssetId, placementAssetId, closedAssetId] } },
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

  it("lets exactly one conflicting review commit for one expected Run and item version", async () => {
    const results = await Promise.allSettled([
      recordCreativeReviewDecision({
        runId: reviewRunId,
        itemId: reviewItemId,
        actor,
        expectedVersion: 1,
        decision: "approved",
        identityConsistency: "passed",
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
        reason: "Reject from the second tab",
        requestId: `review-second-${suffix}`,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: reviewRunId } })).resolves.toMatchObject({
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
      status: "published",
      version: 2,
    });
    await expect(prisma.mediaAssetPlacement.count({
      where: { targetId: placementTargetId, status: "published" },
    })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: { action: "creative.placement.published", requestId: { in: [`placement-first-${suffix}`, `placement-second-${suffix}`] } },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: placementRunId, eventType: "creative.placement.verification_requested.v2" },
    })).resolves.toBe(1);
  });
});
