import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { executeCreativeRetryCommand } from "./retry-executor";
import { recordCreativeReviewDecision } from "./review-decision";

describe("Creative Run lifecycle guards", () => {
  const suffix = randomUUID();
  const actor = { id: `creative-lifecycle-actor-${suffix}`, role: "admin" } as const;
  const profileId = `creative-lifecycle-profile-${suffix}`;
  const blockedStates = ["draft", "closed"] as const;
  const reviewRunIds = blockedStates.map((state) => `creative-review-${state}-${suffix}`);
  const reviewItemIds = blockedStates.map((state) => `creative-review-item-${state}-${suffix}`);
  const reviewAssetIds = blockedStates.map((state) => `creative-review-asset-${state}-${suffix}`);
  const retryRunIds = blockedStates.map((state) => `creative-retry-${state}-${suffix}`);
  const retryItemIds = blockedStates.map((state) => `creative-retry-item-${state}-${suffix}`);
  const retryJobIds = blockedStates.map((state) => `creative-retry-job-${state}-${suffix}`);
  const priorAttemptIds = blockedStates.map((state) => `creative-retry-attempt-${state}-${suffix}`);
  const commandIds = blockedStates.map((state) => `creative-retry-command-${state}-${suffix}`);

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actor.id, email: `${actor.id}@example.test`, role: actor.role, status: "active" },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: profileId,
        profileKey: profileId,
        label: "Creative lifecycle guard profile",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        runnerConfig: { verificationStatus: "passed" },
        allowedOrientations: ["portrait"],
        enabled: true,
        status: "active",
        version: 1,
      },
    });

    for (const [index, state] of blockedStates.entries()) {
      await prisma.mediaAsset.create({
        data: {
          id: reviewAssetIds[index],
          ownerId: actor.id,
          type: "image",
          url: `memory://${reviewAssetIds[index]}`,
          safetyStatus: "passed",
          metadata: {},
        },
      });
      await prisma.contentProductionBatch.create({
        data: {
          id: reviewRunIds[index],
          title: `Review guard ${state}`,
          purpose: "feed",
          targetType: "none",
          presetIds: [],
          count: 1,
          totalItems: 1,
          completedItems: 1,
          status: "reviewing",
          lifecycleState: state,
          workflowStage: "review",
          version: 1,
          createdById: actor.id,
          items: {
            create: {
              id: reviewItemIds[index],
              itemIndex: 0,
              mediaAssetId: reviewAssetIds[index],
              status: "generated",
              tags: [],
            },
          },
        },
      });

      await prisma.generationJob.create({
        data: {
          id: retryJobIds[index],
          userId: actor.id,
          mode: "image",
          controls: {},
          presetIds: [],
          outputCount: 1,
          status: "failed",
          errorCode: "provider_timeout",
          profileId,
          profileVersion: 1,
          model: "mock-image",
          provider: "pipeline",
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: priorAttemptIds[index],
          requestId: retryJobIds[index],
          attemptNo: 1,
          status: "failed",
          retryability: "retryable",
          finishedAt: new Date(),
        },
      });
      await prisma.contentProductionBatch.create({
        data: {
          id: retryRunIds[index],
          title: `Retry guard ${state}`,
          purpose: "feed",
          targetType: "none",
          profileId,
          profileVersion: 1,
          presetIds: [],
          count: 1,
          totalItems: 1,
          failedItems: 1,
          status: "completed",
          lifecycleState: state,
          workflowStage: "generation",
          version: 1,
          createdById: actor.id,
          items: {
            create: {
              id: retryItemIds[index],
              itemIndex: 0,
              jobId: retryJobIds[index],
              status: "failed",
              tags: [],
            },
          },
        },
      });
      await prisma.controlPlaneCommand.create({
        data: {
          id: commandIds[index],
          scope: `creative-lifecycle:${actor.id}`,
          idempotencyKey: `creative-lifecycle-${state}-${suffix}`,
          commandType: "creative.run.retry_failed",
          targetType: "creative_run",
          targetId: retryRunIds[index],
          actorId: actor.id,
          requestId: `creative-lifecycle-${state}-${suffix}`,
          requestHash: `creative-lifecycle-${state}-${suffix}`,
          requestPayload: { failedItemIds: [retryItemIds[index]] },
          expectedVersion: 1,
          retryMode: "idempotent",
          status: "accepted",
        },
      });
    }
  });

  afterAll(async () => {
    const allRunIds = [...reviewRunIds, ...retryRunIds];
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commandIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: allRunIds } } });
    await prisma.adminAuditLog.deleteMany({
      where: { OR: [{ targetId: { in: allRunIds } }, { targetId: { in: [...reviewItemIds, ...retryItemIds] } }] },
    });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: { in: reviewItemIds } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: allRunIds } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: priorAttemptIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: retryJobIds } } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: reviewAssetIds } } });
    await prisma.generationModelProfile.delete({ where: { id: profileId } });
    await prisma.user.delete({ where: { id: actor.id } });
    await prisma.$disconnect();
  });

  it("rejects review for draft and closed Runs without domain, audit, outbox, or command effects", async () => {
    for (const [index, state] of blockedStates.entries()) {
      await expect(recordCreativeReviewDecision({
        runId: reviewRunIds[index],
        itemId: reviewItemIds[index],
        actor,
        expectedVersion: 1,
        decision: "approved",
        identityConsistency: "passed",
        reason: `Reject review while lifecycle is ${state}`,
        requestId: `creative-review-${state}-${suffix}`,
      })).rejects.toThrow("Creative Run is not active for review");

      await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: reviewRunIds[index] } })).resolves.toMatchObject({
        lifecycleState: state,
        workflowStage: "review",
        version: 1,
      });
      await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: reviewItemIds[index] } })).resolves.toMatchObject({
        status: "generated",
        version: 1,
      });
      await expect(prisma.creativeReviewDecision.count({ where: { runItemId: reviewItemIds[index] } })).resolves.toBe(0);
      await expect(prisma.adminAuditLog.count({ where: { targetId: reviewItemIds[index] } })).resolves.toBe(0);
      await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: reviewRunIds[index] } })).resolves.toBe(0);
      await expect(prisma.controlPlaneCommand.count({ where: { targetId: reviewRunIds[index] } })).resolves.toBe(0);
    }
  });

  it("rejects retry for draft and closed Runs without generation or domain effects", async () => {
    for (const [index, state] of blockedStates.entries()) {
      await expect(executeCreativeRetryCommand(prisma, {
        commandId: commandIds[index],
        workerId: `creative-lifecycle-worker-${state}-${suffix}`,
      })).rejects.toThrow("Creative Run is not active for retry");

      await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: retryRunIds[index] } })).resolves.toMatchObject({
        lifecycleState: state,
        workflowStage: "generation",
        version: 1,
      });
      await expect(prisma.contentProductionItem.findUniqueOrThrow({ where: { id: retryItemIds[index] } })).resolves.toMatchObject({
        status: "failed",
        version: 1,
      });
      await expect(prisma.generationJob.findUniqueOrThrow({ where: { id: retryJobIds[index] } })).resolves.toMatchObject({
        status: "failed",
        version: 1,
      });
      await expect(prisma.generationAttempt.count({ where: { sourceCommandId: commandIds[index] } })).resolves.toBe(0);
      await expect(prisma.adminAuditLog.count({ where: { targetId: retryRunIds[index] } })).resolves.toBe(0);
      await expect(prisma.mainOutboxEvent.count({ where: { aggregateId: retryRunIds[index] } })).resolves.toBe(0);
      await expect(prisma.controlPlaneCommand.findUniqueOrThrow({ where: { id: commandIds[index] } })).resolves.toMatchObject({
        status: "failed",
      });
    }
  });
});
