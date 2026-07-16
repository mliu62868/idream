import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { CREATIVE_MEDIA_AUTHORITY_METADATA_KEY } from "@/server/lib/creative-media-authority";
import { resolveCommunityCampaignPlacements } from "@/server/modules/ourdream/community-campaigns";
import {
  publishDistributionPlacement,
  recordCreativeReviewDecision,
  verifyCreativePlacement,
} from "./workflow";

describe("Creative customer media authority", () => {
  const suffix = randomUUID();
  const adminId = `creative-authority-admin-${suffix}`;
  const reviewRunId = `creative-authority-review-run-${suffix}`;
  const reviewItemId = `creative-authority-review-item-${suffix}`;
  const reviewAssetId = `creative-authority-review-asset-${suffix}`;
  const placementRunId = `creative-authority-placement-run-${suffix}`;
  const placementItemId = `creative-authority-placement-item-${suffix}`;
  const placementAssetId = `creative-authority-placement-asset-${suffix}`;
  const verificationRunId = `creative-authority-verification-run-${suffix}`;
  const verificationItemId = `creative-authority-verification-item-${suffix}`;
  const verificationAssetId = `creative-authority-verification-asset-${suffix}`;
  const verificationPlacementId = `creative-authority-verification-placement-${suffix}`;
  const servingAssetId = `creative-authority-serving-asset-${suffix}`;
  const servingSyntheticAssetId = `creative-authority-serving-synthetic-${suffix}`;
  const servingMalformedAssetId = `creative-authority-serving-malformed-${suffix}`;
  const servingPlacementId = `creative-authority-serving-placement-${suffix}`;
  const servingSyntheticPlacementId = `creative-authority-serving-synthetic-placement-${suffix}`;
  const servingMalformedPlacementId = `creative-authority-serving-malformed-placement-${suffix}`;
  const providerReviewRunId = `creative-authority-provider-review-run-${suffix}`;
  const providerReviewItemId = `creative-authority-provider-review-item-${suffix}`;
  const providerReviewAssetId = `creative-authority-provider-review-asset-${suffix}`;
  const providerReviewJobId = `creative-authority-provider-review-job-${suffix}`;
  const providerServingPlacementId = `creative-authority-provider-serving-placement-${suffix}`;
  const providerPlacementRunId = `creative-authority-provider-placement-run-${suffix}`;
  const providerPlacementItemId = `creative-authority-provider-placement-item-${suffix}`;
  const providerPlacementAssetId = `creative-authority-provider-placement-asset-${suffix}`;
  const providerPlacementJobId = `creative-authority-provider-placement-job-${suffix}`;
  const providerPlacementAttemptId = `creative-authority-provider-placement-attempt-${suffix}`;
  const providerVerificationRunId = `creative-authority-provider-verification-run-${suffix}`;
  const providerVerificationItemId = `creative-authority-provider-verification-item-${suffix}`;
  const providerVerificationAssetId = `creative-authority-provider-verification-asset-${suffix}`;
  const providerVerificationJobId = `creative-authority-provider-verification-job-${suffix}`;
  const providerVerificationAttemptId = `creative-authority-provider-verification-attempt-${suffix}`;
  const providerVerificationDriftAttemptId = `creative-authority-provider-verification-drift-${suffix}`;
  const providerVerificationPlacementId = `creative-authority-provider-verification-placement-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: adminId,
        email: `${adminId}@example.test`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: reviewAssetId,
        ownerId: adminId,
        type: "image",
        url: `memory://${reviewAssetId}`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: true, source: "mock" },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: reviewRunId,
        title: "Synthetic review authority fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        presetIds: [],
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        workflowStage: "review",
        verificationState: "pending",
        version: 1,
        createdById: adminId,
        items: {
          create: {
            id: reviewItemId,
            itemIndex: 0,
            status: "generated",
            mediaAssetId: reviewAssetId,
            tags: [],
          },
        },
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: placementAssetId,
        ownerId: adminId,
        type: "image",
        url: `memory://${placementAssetId}`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: "true", source: "legacy_mock" },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: placementRunId,
        title: "Malformed placement authority fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        presetIds: [],
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        workflowStage: "placement",
        verificationState: "pending",
        version: 1,
        createdById: adminId,
        items: {
          create: {
            id: placementItemId,
            itemIndex: 0,
            status: "approved",
            mediaAssetId: placementAssetId,
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
        identityConsistency: "unscored",
        score: 90,
        reason: "Legacy approved decision fixture",
        reviewerId: adminId,
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: verificationAssetId,
        ownerId: adminId,
        type: "image",
        url: `memory://${verificationAssetId}`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: true, source: "mock" },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: verificationRunId,
        title: "Synthetic verification authority fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `verification-campaign-${suffix}`,
        presetIds: [],
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        workflowStage: "verification",
        verificationState: "verifying",
        version: 1,
        createdById: adminId,
        items: {
          create: {
            id: verificationItemId,
            itemIndex: 0,
            status: "approved",
            mediaAssetId: verificationAssetId,
            tags: [],
          },
        },
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: verificationPlacementId,
        mediaAssetId: verificationAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `verification-campaign-${suffix}`,
        status: "scheduled",
        createdById: adminId,
        metadata: {
          creativeRunId: verificationRunId,
          creativeRunItemId: verificationItemId,
        },
        verificationState: "verifying",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: servingAssetId,
          ownerId: adminId,
          type: "image",
          url: `memory://${servingAssetId}`,
          visibility: "unlisted",
          safetyStatus: "passed",
          metadata: { synthetic: false },
        },
        {
          id: servingSyntheticAssetId,
          ownerId: adminId,
          type: "image",
          url: `memory://${servingSyntheticAssetId}`,
          visibility: "unlisted",
          safetyStatus: "passed",
          metadata: { synthetic: true, source: "mock" },
        },
        {
          id: servingMalformedAssetId,
          ownerId: adminId,
          type: "image",
          url: `memory://${servingMalformedAssetId}`,
          visibility: "unlisted",
          safetyStatus: "passed",
          metadata: { synthetic: "false", source: "legacy_mock" },
        },
      ],
    });
    await prisma.mediaAssetPlacement.createMany({
      data: [
        {
          id: servingPlacementId,
          mediaAssetId: servingAssetId,
          slot: "campaign",
          targetType: "campaign",
          targetId: `serving-authoritative-${suffix}`,
          status: "published",
          publishedAt: new Date("2099-01-01T00:00:00.000Z"),
          createdById: adminId,
          metadata: {},
          verificationState: "passed",
          verifiedAt: new Date(),
        },
        {
          id: servingSyntheticPlacementId,
          mediaAssetId: servingSyntheticAssetId,
          slot: "campaign",
          targetType: "campaign",
          targetId: `serving-synthetic-${suffix}`,
          status: "published",
          publishedAt: new Date("2099-01-01T00:00:00.000Z"),
          createdById: adminId,
          metadata: {},
          verificationState: "passed",
          verifiedAt: new Date(),
        },
        {
          id: servingMalformedPlacementId,
          mediaAssetId: servingMalformedAssetId,
          slot: "campaign",
          targetType: "campaign",
          targetId: `serving-malformed-${suffix}`,
          status: "published",
          publishedAt: new Date("2099-01-01T00:00:00.000Z"),
          createdById: adminId,
          metadata: {},
          verificationState: "passed",
          verifiedAt: new Date(),
        },
      ],
    });
    await prisma.generationJob.create({
      data: {
        id: providerReviewJobId,
        userId: adminId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "mock-image",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: providerReviewAssetId,
        ownerId: adminId,
        sourceJobId: providerReviewJobId,
        type: "image",
        url: `memory://${providerReviewAssetId}`,
        visibility: "unlisted",
        safetyStatus: "passed",
        metadata: { synthetic: false },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: providerReviewRunId,
        title: "Mock provider review authority fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `provider-review-campaign-${suffix}`,
        presetIds: [],
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        workflowStage: "review",
        verificationState: "pending",
        version: 1,
        createdById: adminId,
        items: {
          create: {
            id: providerReviewItemId,
            itemIndex: 0,
            status: "generated",
            mediaAssetId: providerReviewAssetId,
            tags: [],
          },
        },
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: providerServingPlacementId,
        mediaAssetId: providerReviewAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `provider-serving-campaign-${suffix}`,
        status: "published",
        publishedAt: new Date("2099-01-01T00:00:01.000Z"),
        createdById: adminId,
        metadata: {},
        verificationState: "passed",
        verifiedAt: new Date(),
      },
    });
    await prisma.generationJob.create({
      data: {
        id: providerPlacementJobId,
        userId: adminId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "comfyui",
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: providerPlacementAttemptId,
        requestId: providerPlacementJobId,
        attemptNo: 1,
        provider: "mock-worker",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: providerPlacementAssetId,
        ownerId: adminId,
        sourceJobId: providerPlacementJobId,
        type: "image",
        url: `memory://${providerPlacementAssetId}`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: providerPlacementRunId,
        title: "Mock attempt placement authority fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `provider-placement-campaign-${suffix}`,
        presetIds: [],
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        workflowStage: "placement",
        verificationState: "pending",
        version: 1,
        createdById: adminId,
        items: {
          create: {
            id: providerPlacementItemId,
            itemIndex: 0,
            status: "approved",
            mediaAssetId: providerPlacementAssetId,
            tags: [],
          },
        },
      },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        runItemId: providerPlacementItemId,
        artifactId: providerPlacementAssetId,
        decision: "approved",
        identityConsistency: "unscored",
        score: 90,
        reason: "Provider placement decision fixture",
        reviewerId: adminId,
      },
    });
    await prisma.generationJob.create({
      data: {
        id: providerVerificationJobId,
        userId: adminId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        provider: "comfyui",
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: providerVerificationAttemptId,
        requestId: providerVerificationJobId,
        attemptNo: 1,
        provider: "comfyui",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: providerVerificationAssetId,
        ownerId: adminId,
        sourceJobId: providerVerificationJobId,
        type: "image",
        url: `memory://${providerVerificationAssetId}`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: false },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: providerVerificationRunId,
        title: "Provider drift verification authority fixture",
        purpose: "campaign",
        targetType: "campaign",
        targetId: `provider-verification-campaign-${suffix}`,
        presetIds: [],
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "reviewing",
        workflowStage: "verification",
        verificationState: "verifying",
        version: 1,
        createdById: adminId,
        items: {
          create: {
            id: providerVerificationItemId,
            itemIndex: 0,
            status: "approved",
            mediaAssetId: providerVerificationAssetId,
            tags: [],
          },
        },
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: providerVerificationPlacementId,
        mediaAssetId: providerVerificationAssetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `provider-verification-campaign-${suffix}`,
        status: "scheduled",
        createdById: adminId,
        metadata: {
          creativeRunId: providerVerificationRunId,
          creativeRunItemId: providerVerificationItemId,
          [CREATIVE_MEDIA_AUTHORITY_METADATA_KEY]: {
            sourceJobId: providerVerificationJobId,
            jobProvider: "comfyui",
            latestAttemptProvider: "comfyui",
          },
        },
        verificationState: "verifying",
      },
    });
  });

  afterAll(async () => {
    await prisma.creativeReviewDecision.deleteMany({
      where: {
        runItemId: {
          in: [
            reviewItemId,
            placementItemId,
            providerReviewItemId,
            providerPlacementItemId,
          ],
        },
      },
    });
    await prisma.mediaAssetPlacement.deleteMany({
      where: {
        mediaAssetId: {
          in: [
            placementAssetId,
            verificationAssetId,
            servingAssetId,
            servingSyntheticAssetId,
            servingMalformedAssetId,
            providerReviewAssetId,
            providerPlacementAssetId,
            providerVerificationAssetId,
          ],
        },
      },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        aggregateId: {
          in: [
            reviewRunId,
            placementRunId,
            verificationRunId,
            providerReviewRunId,
            providerPlacementRunId,
            providerVerificationRunId,
          ],
        },
      },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.contentProductionItem.deleteMany({
      where: {
        batchId: {
          in: [
            reviewRunId,
            placementRunId,
            verificationRunId,
            providerReviewRunId,
            providerPlacementRunId,
            providerVerificationRunId,
          ],
        },
      },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: {
        id: {
          in: [
            reviewRunId,
            placementRunId,
            verificationRunId,
            providerReviewRunId,
            providerPlacementRunId,
            providerVerificationRunId,
          ],
        },
      },
    });
    await prisma.mediaAsset.deleteMany({
      where: {
        id: {
          in: [
            reviewAssetId,
            placementAssetId,
            verificationAssetId,
            servingAssetId,
            servingSyntheticAssetId,
            servingMalformedAssetId,
            providerReviewAssetId,
            providerPlacementAssetId,
            providerVerificationAssetId,
          ],
        },
      },
    });
    await prisma.generationAttempt.deleteMany({
      where: {
        requestId: {
          in: [providerPlacementJobId, providerVerificationJobId],
        },
      },
    });
    await prisma.generationJob.deleteMany({
      where: {
        id: {
          in: [
            providerReviewJobId,
            providerPlacementJobId,
            providerVerificationJobId,
          ],
        },
      },
    });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it("rejects approval of an explicitly synthetic asset", async () => {
    await expect(recordCreativeReviewDecision({
      runId: reviewRunId,
      itemId: reviewItemId,
      actor: { id: adminId, role: "admin" },
      expectedVersion: 1,
      decision: "approved",
      identityConsistency: "unscored",
      score: 92,
      reason: "Approve a campaign asset",
      requestId: `creative-authority-review-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      details: {
        mediaAssetId: reviewAssetId,
        reasons: ["metadata_synthetic"],
      },
    });
  });

  it("rejects approval when immutable job provenance uses a mock provider", async () => {
    await expect(recordCreativeReviewDecision({
      runId: providerReviewRunId,
      itemId: providerReviewItemId,
      actor: { id: adminId, role: "admin" },
      expectedVersion: 1,
      decision: "approved",
      identityConsistency: "unscored",
      score: 92,
      reason: "Approve a provider-backed campaign asset",
      requestId: `creative-authority-provider-review-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      details: {
        mediaAssetId: providerReviewAssetId,
        reasons: expect.arrayContaining(["job_provider_mock"]),
      },
    });
  });

  it("rejects placement when the latest immutable attempt uses a mock provider", async () => {
    await expect(publishDistributionPlacement({
      runId: providerPlacementRunId,
      itemId: providerPlacementItemId,
      assetId: providerPlacementAssetId,
      actor: { id: adminId, role: "admin" },
      expectedVersion: 1,
      slot: "campaign",
      targetType: "campaign",
      targetId: `provider-placement-campaign-${suffix}`,
      reason: "Publish a mock-attempt campaign asset",
      requestId: `creative-authority-provider-placement-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      details: {
        mediaAssetId: providerPlacementAssetId,
        reasons: expect.arrayContaining(["latest_attempt_provider_mock"]),
      },
    });
  });

  it("rejects placement of an asset with a malformed synthetic marker", async () => {
    await expect(publishDistributionPlacement({
      runId: placementRunId,
      itemId: placementItemId,
      assetId: placementAssetId,
      actor: { id: adminId, role: "admin" },
      expectedVersion: 1,
      slot: "campaign",
      targetType: "campaign",
      targetId: `campaign-${suffix}`,
      reason: "Publish a malformed legacy asset",
      requestId: `creative-authority-placement-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      details: {
        mediaAssetId: placementAssetId,
        reasons: ["metadata_synthetic_marker_invalid"],
      },
    });
  });

  it("rejects verification when a staged asset is synthetic", async () => {
    await expect(verifyCreativePlacement({
      runId: verificationRunId,
      placementId: verificationPlacementId,
      actor: { id: adminId, role: "admin" },
      expectedVersion: 1,
      reason: "Verify the staged campaign asset",
      requestId: `creative-authority-verification-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      details: {
        mediaAssetId: verificationAssetId,
        reasons: ["metadata_synthetic"],
      },
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: verificationPlacementId },
    })).resolves.toMatchObject({
      status: "scheduled",
      verificationState: "verifying",
      publishedAt: null,
    });
  });

  it("rejects verification when latest-attempt provider authority drifts to mock", async () => {
    await prisma.generationAttempt.create({
      data: {
        id: providerVerificationDriftAttemptId,
        requestId: providerVerificationJobId,
        attemptNo: 2,
        provider: "mock-worker",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await expect(verifyCreativePlacement({
      runId: providerVerificationRunId,
      placementId: providerVerificationPlacementId,
      actor: { id: adminId, role: "admin" },
      expectedVersion: 1,
      reason: "Verify immutable provider evidence",
      requestId: `creative-authority-provider-verification-${suffix}`,
    })).rejects.toMatchObject({
      status: 400,
      details: {
        mediaAssetId: providerVerificationAssetId,
        reasons: expect.arrayContaining([
          "latest_attempt_provider_mock",
          "latest_attempt_provider_changed",
        ]),
      },
    });
  });

  it("serves only authoritative campaign media", async () => {
    const firstPlacement = await resolveCommunityCampaignPlacements(prisma, 1);
    expect(firstPlacement.map((placement) => placement.id)).toEqual([
      servingPlacementId,
    ]);
    const placements = await resolveCommunityCampaignPlacements(prisma, 100);
    const placementIds = new Set(placements.map((placement) => placement.id));
    expect(placementIds.has(servingPlacementId)).toBe(true);
    expect(placementIds.has(providerServingPlacementId)).toBe(false);
    expect(placementIds.has(servingSyntheticPlacementId)).toBe(false);
    expect(placementIds.has(servingMalformedPlacementId)).toBe(false);
    await expect(prisma.mediaAssetPlacement.count({
      where: {
        id: {
          in: [
            providerServingPlacementId,
            servingSyntheticPlacementId,
            servingMalformedPlacementId,
          ],
        },
      },
    })).resolves.toBe(3);
  });
});
