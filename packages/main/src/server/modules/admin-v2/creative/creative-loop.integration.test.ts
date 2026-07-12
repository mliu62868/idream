import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as retryFailed } from "@/app/api/v2/admin/creative/runs/[id]/commands/retry-failed/route";
import { GET as getRun } from "@/app/api/v2/admin/creative/runs/[id]/route";
import { GET as listRuns } from "@/app/api/v2/admin/creative/runs/route";
import { POST as decideItem } from "@/app/api/v2/admin/creative/runs/[id]/items/[itemId]/decisions/route";
import { POST as publishPlacement } from "@/app/api/v2/admin/creative/runs/[id]/placements/route";
import { POST as verifyPlacement } from "@/app/api/v2/admin/creative/runs/[id]/placements/[placementId]/verification/route";
import { prisma } from "@/server/lib/db";
import { verifyCreativePlacement } from "./workflow";
import {
  dispatchCreativeRetryOutbox,
  executeCreativeRetryCommand,
  verifyCreativeRetryCommands,
} from "./retry-executor";
import { jobQueue } from "@/server/jobs/queue";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";

describe("Creative retry through verified placement", () => {
  const suffix = randomUUID();
  const adminId = `creative-admin-${suffix}`;
  const runId = `creative-run-${suffix}`;
  const itemId = `creative-item-${suffix}`;
  const jobId = `creative-job-${suffix}`;
  const firstAttemptId = `creative-attempt-1-${suffix}`;
  const profileId = `creative-profile-${suffix}`;
  const assetId = `creative-asset-${suffix}`;
  let commandId = "";
  let placementId = "";
  let unsupportedPlacementId = "";
  const request = (path: string, body?: unknown) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-idream-user-id": adminId,
      "x-idream-role": "admin",
      "x-request-id": randomUUID(),
    };
    if (body) headers["idempotency-key"] = `creative-loop-${suffix}-${randomUUID()}`;
    return new Request(`http://localhost${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: profileId,
        profileKey: profileId,
        label: "Healthy creative test profile",
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
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId: adminId,
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
        sourceType: "content_production_item",
        sourceId: itemId,
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: firstAttemptId,
        requestId: jobId,
        attemptNo: 1,
        provider: "pipeline",
        profileKey: profileId,
        profileVersion: 1,
        status: "failed",
        errorClass: "provider",
        errorCode: "provider_timeout",
        errorSignature: `pipeline:${profileId}:provider_timeout`,
        retryability: "retryable",
        finishedAt: new Date(),
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Creative closed-loop fixture",
        purpose: "feed",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        profileId,
        profileVersion: 1,
        presetIds: [],
        count: 1,
        totalItems: 1,
        failedItems: 1,
        status: "completed",
        lifecycleState: "active",
        workflowStage: "generation",
        verificationState: "pending",
        version: 2,
        createdById: adminId,
        ownerId: adminId,
        items: {
          create: { id: itemId, itemIndex: 0, jobId, status: "failed", tags: [] },
        },
      },
    });
  });

  afterAll(async () => {
    await jobQueue.removeByDedupePrefix(`generation:${jobId}:attempt:`, ["ai.image.generate"]);
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: itemId } });
    await prisma.mediaAssetPlacement.deleteMany({ where: { id: { in: [placementId, unsupportedPlacementId].filter(Boolean) } } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
    await prisma.generationArtifact.deleteMany({
      where: { attemptId: { in: (await prisma.generationAttempt.findMany({ where: { requestId: jobId }, select: { id: true } })).map((row) => row.id) } },
    });
    await prisma.generationTransportExecution.deleteMany({
      where: { attemptId: { in: (await prisma.generationAttempt.findMany({ where: { requestId: jobId }, select: { id: true } })).map((row) => row.id) } },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: [runId, itemId, placementId || "missing"] } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: adminId } });
    await prisma.contentProductionItem.deleteMany({ where: { batchId: runId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: runId } });
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: jobId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.generationModelProfile.deleteMany({ where: { id: profileId } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it("recovers only the failed item and keeps the command verifying until output exists", async () => {
    const response = await retryFailed(
      new Request(`http://localhost/api/v2/admin/creative/runs/${runId}/commands/retry-failed`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": adminId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
          "idempotency-key": `creative-retry-${suffix}`,
          "if-match": '"2"',
        },
        body: JSON.stringify({
          entityVersion: 2,
          reason: { code: "provider_recovered", summary: "Provider health is verified" },
          confirmation: `${runId}:retry-failed`,
        }),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(response.status).toBe(202);
    commandId = (await response.json()).data.commandId;

    const executed = await executeCreativeRetryCommand(prisma, {
      commandId,
      workerId: `creative-worker-${suffix}`,
    });
    expect(executed.status).toBe("verifying");
    const retryAttempts = await prisma.generationAttempt.findMany({
      where: { sourceCommandId: commandId },
    });
    expect(retryAttempts).toHaveLength(1);
    expect(retryAttempts[0]).toMatchObject({
      requestId: jobId,
      attemptNo: 2,
      creativeRunItemId: itemId,
      status: "queued",
    });
    expect(await prisma.mainOutboxEvent.count({
      where: { eventType: "creative.retry.dispatch.v2", aggregateId: runId },
    })).toBe(1);
    expect(await prisma.contentProductionBatch.findUnique({ where: { id: runId } })).toMatchObject({
      workflowStage: "generation",
      verificationState: "verifying",
      version: 3,
    });
    expect(await dispatchCreativeRetryOutbox(prisma, {
      limit: 10,
      outboxIds: [`creative_retry_${commandId}_${itemId}`],
    })).toMatchObject({ delivered: 1, failed: 0 });
    expect(await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}:attempt:2`)).toMatchObject({
      payload: expect.objectContaining({
        generationJobId: jobId,
        attemptId: retryAttempts[0].id,
        attemptNo: 2,
      }),
    });

    await executeCreativeRetryCommand(prisma, {
      commandId,
      workerId: `creative-worker-replay-${suffix}`,
    });
    expect(await prisma.generationAttempt.count({ where: { sourceCommandId: commandId } })).toBe(1);

    await prisma.$transaction(async (tx) => {
      await tx.mediaAsset.create({
        data: {
          id: assetId,
          ownerId: adminId,
          sourceJobId: jobId,
          type: "image",
          url: `/user-content/${assetId}/content.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      });
      const succeededAt = new Date();
      await recordGenerationAttemptEvent(tx, {
        eventId: `${retryAttempts[0].id}:terminal`,
        attemptId: retryAttempts[0].id,
        eventType: "generation.attempt.succeeded.v1",
        outcome: "succeeded",
        occurredAt: succeededAt,
        payload: { requestId: jobId, source: "creative_loop_fixture" },
      });
      await tx.generationJob.update({
        where: { id: jobId },
        data: { status: "completed", completedAt: new Date(), errorCode: null },
      });
      await tx.contentProductionItem.update({
        where: { id: itemId },
        data: { status: "generated", mediaAssetId: assetId, version: { increment: 1 } },
      });
    });

    expect(await verifyCreativeRetryCommands(prisma, { limit: 10 })).toMatchObject({ passed: 1, failed: 0 });
    expect(await prisma.controlPlaneCommand.findUnique({ where: { id: commandId } })).toMatchObject({
      status: "succeeded",
      needsReconciliation: false,
    });
    expect(await prisma.contentProductionBatch.findUnique({ where: { id: runId } })).toMatchObject({
      workflowStage: "review",
      verificationState: "pending",
      version: 4,
    });
  });

  it("records immutable review, publishes a distribution placement, and verifies the served slot", async () => {
    const reviewResponse = await decideItem(
      request(`/api/v2/admin/creative/runs/${runId}/items/${itemId}/decisions`, {
        entityVersion: 4,
        decision: "approved",
        identityConsistency: "passed",
        score: 94,
        reason: "Asset matches the brief and identity evidence",
      }),
      { params: Promise.resolve({ id: runId, itemId }) },
    );
    expect(reviewResponse.status).toBe(200);
    const reviewed = (await reviewResponse.json()).data;
    expect(reviewed).toMatchObject({ workflowStage: "placement", version: 5 });
    expect(await prisma.creativeReviewDecision.count({ where: { runItemId: itemId } })).toBe(1);

    const placementResponse = await publishPlacement(
      request(`/api/v2/admin/creative/runs/${runId}/placements`, {
        entityVersion: 5,
        itemId,
        assetId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        reason: "Publish approved campaign card",
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    expect(placementResponse.status).toBe(200);
    const placement = (await placementResponse.json()).data;
    placementId = placement.placementId;
    expect(placement).toMatchObject({ verificationState: "verifying", runVersion: 6 });

    const verificationResponse = await verifyPlacement(
      request(`/api/v2/admin/creative/runs/${runId}/placements/${placementId}/verification`, {
        entityVersion: 6,
        reason: "Observed the current distribution slot serving the expected asset",
      }),
      { params: Promise.resolve({ id: runId, placementId }) },
    );
    expect(verificationResponse.status).toBe(200);
    const verified = (await verificationResponse.json()).data;
    expect(verified).toMatchObject({
      verificationState: "passed",
      runVersion: 7,
      checks: {
        runtimeSurfaceSupported: true,
        placementVisibleInRuntime: true,
        renderedAssetMatches: true,
      },
    });
    const terminalVerificationEffects = await Promise.all([
      prisma.adminAuditLog.count({ where: { targetId: placementId, action: "creative.placement.verified" } }),
      prisma.mainOutboxEvent.count({ where: { aggregateId: runId, eventType: { in: ["creative.placement.verified.v2", "creative.placement.verification_failed.v2"] } } }),
    ]);
    await expect(verifyCreativePlacement({
      runId,
      placementId,
      actor: { id: adminId, role: "admin" },
      expectedVersion: 7,
      reason: "A passed verification is terminal and cannot be rewritten",
      requestId: `creative-terminal-verification-${suffix}`,
    })).rejects.toThrow("verification transition");
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } })).resolves.toMatchObject({
      workflowStage: "verification",
      verificationState: "passed",
      version: 7,
    });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({ where: { id: placementId } })).resolves.toMatchObject({
      verificationState: "passed",
      version: 2,
    });
    await expect(Promise.all([
      prisma.adminAuditLog.count({ where: { targetId: placementId, action: "creative.placement.verified" } }),
      prisma.mainOutboxEvent.count({ where: { aggregateId: runId, eventType: { in: ["creative.placement.verified.v2", "creative.placement.verification_failed.v2"] } } }),
    ])).resolves.toEqual(terminalVerificationEffects);
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({ visibility: "unlisted" });

    const detailResponse = await getRun(request(`/api/v2/admin/creative/runs/${runId}`), {
      params: Promise.resolve({ id: runId }),
    });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()).data;
    expect(detail).toMatchObject({
      id: runId,
      workflowStage: "verification",
      executionOutcome: "succeeded",
      reviewState: "complete",
      deploymentState: "placed",
      verificationState: "passed",
      counts: { generated: 1, failed: 0, reviewed: 1, approved: 1, placed: 1, total: 1 },
      version: 7,
    });
    expect(detail.items[0].lineage).toMatchObject({
      requestId: jobId,
      attemptId: expect.any(String),
      assetId,
      reviewDecisionId: expect.any(String),
      placementVersionId: placementId,
    });
    const listResponse = await listRuns(request(`/api/v2/admin/creative/runs?search=${runId}&limit=10`));
    const listBody = await listResponse.json();
    expect(listResponse.status, JSON.stringify(listBody)).toBe(200);
    expect(listBody).toMatchObject({
      data: {
        items: [{ id: runId, executionOutcome: "succeeded", verificationState: "passed" }],
      },
    });

    const unsupportedPlacementResponse = await publishPlacement(
      request(`/api/v2/admin/creative/runs/${runId}/placements`, {
        entityVersion: 7,
        itemId,
        assetId,
        slot: "feed_card",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        reason: "Prove a slot without a runtime renderer cannot self-verify",
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    unsupportedPlacementId = (await unsupportedPlacementResponse.json()).data.placementId;
    const unsupportedVerification = await verifyPlacement(
      request(`/api/v2/admin/creative/runs/${runId}/placements/${unsupportedPlacementId}/verification`, {
        entityVersion: 8,
        reason: "Runtime resolver is intentionally unavailable for feed_card",
      }),
      { params: Promise.resolve({ id: runId, placementId: unsupportedPlacementId }) },
    );
    expect((await unsupportedVerification.json()).data).toMatchObject({
      verificationState: "failed",
      runVersion: 9,
      checks: { runtimeSurfaceSupported: false, placementVisibleInRuntime: false },
    });
    expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      lifecycleState: "active",
      status: "reviewing",
      verificationState: "failed",
    });
    const mutationReceipts = await prisma.controlPlaneCommand.findMany({
      where: {
        actorId: adminId,
        commandType: {
          in: ["creative.review.decision", "creative.placement.publish", "creative.placement.verify"],
        },
      },
      select: { commandType: true },
    });
    expect(mutationReceipts.filter(({ commandType }) => commandType === "creative.review.decision")).toHaveLength(1);
    expect(mutationReceipts.filter(({ commandType }) => commandType === "creative.placement.publish")).toHaveLength(2);
    expect(mutationReceipts.filter(({ commandType }) => commandType === "creative.placement.verify")).toHaveLength(2);

    const publishedReview = await decideItem(
      request(`/api/v2/admin/creative/runs/${runId}/items/${itemId}/decisions`, {
        entityVersion: 9,
        decision: "rejected",
        identityConsistency: "failed",
        reason: "A published immutable item cannot be rewritten by a later review",
      }),
      { params: Promise.resolve({ id: runId, itemId }) },
    );
    expect(publishedReview.status).toBe(409);
    expect(await prisma.creativeReviewDecision.count({ where: { runItemId: itemId } })).toBe(1);
    expect(await prisma.controlPlaneCommand.count({
      where: { actorId: adminId, commandType: "creative.review.decision" },
    })).toBe(1);
  });

  it("scans past non-matching derived outcomes without returning an unpageable false empty", async () => {
    const prefix = `creative-filter-scan-${suffix}`;
    const failedRunIds = Array.from({ length: 51 }, (_, index) => `${prefix}-a-${String(index).padStart(3, "0")}`);
    const succeededRunId = `${prefix}-z-succeeded`;
    const scanAssetId = `${prefix}-asset`;
    const scanItemId = `${prefix}-item`;
    await prisma.mediaAsset.create({ data: {
      id: scanAssetId,
      ownerId: adminId,
      type: "image",
      url: `memory://${scanAssetId}`,
      safetyStatus: "passed",
      metadata: {},
    } });
    await prisma.contentProductionBatch.createMany({ data: failedRunIds.map((id) => ({
      id,
      title: id,
      purpose: "model_eval",
      targetType: "none",
      presetIds: [],
      count: 1,
      totalItems: 1,
      failedItems: 1,
      status: "completed",
      createdById: adminId,
    })) });
    await prisma.contentProductionBatch.create({ data: {
      id: succeededRunId,
      title: succeededRunId,
      purpose: "model_eval",
      targetType: "none",
      presetIds: [],
      count: 1,
      totalItems: 1,
      completedItems: 1,
      status: "completed",
      createdById: adminId,
      items: { create: { id: scanItemId, itemIndex: 0, status: "generated", mediaAssetId: scanAssetId, tags: [] } },
    } });
    try {
      const response = await listRuns(request(`/api/v2/admin/creative/runs?search=${prefix}&executionOutcome=succeeded&limit=10`));
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.data.items.map((item: { id: string }) => item.id)).toEqual([succeededRunId]);
      expect(body.data.pageInfo).toEqual({ endCursor: null, hasNextPage: false });
    } finally {
      await prisma.contentProductionItem.deleteMany({ where: { id: scanItemId } });
      await prisma.contentProductionBatch.deleteMany({ where: { id: { in: [...failedRunIds, succeededRunId] } } });
      await prisma.mediaAsset.deleteMany({ where: { id: scanAssetId } });
    }
  });
});
