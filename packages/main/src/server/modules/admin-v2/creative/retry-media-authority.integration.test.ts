import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as retryFailed } from "@/app/api/v2/admin/creative/runs/[id]/commands/retry-failed/route";
import { prisma } from "@/server/lib/db";
import { patchContentAsset } from "@/server/modules/admin/content-ops";
import { executeCreativeRetryCommand } from "./retry-executor";

describe("Creative retry media and dispatch authority", () => {
  const suffix = randomUUID();
  const actorId = `creative-retry-authority-actor-${suffix}`;
  const profileId = `creative-retry-authority-profile-${suffix}`;
  const profileKey = `chat-image-edit-retry-authority-${suffix}`;
  const workflowKey = "qwen-image-edit-img2img";
  const scenarios = {
    archived: scenario("archived"),
    valid: scenario("valid"),
    workflowKeyDrift: scenario("workflow-key-drift", {
      pinnedWorkflowKey: "qwen-image-edit-multi-identity",
    }),
    workflowVersionDrift: scenario("workflow-version-drift", {
      pinnedWorkflowVersion: 999,
    }),
  } as const;
  const commandIds: string[] = [];

  function scenario(
    label: string,
    overrides: {
      pinnedWorkflowKey?: string;
      pinnedWorkflowVersion?: number;
    } = {},
  ) {
    return {
      label,
      runId: `creative-retry-authority-run-${label}-${suffix}`,
      itemId: `creative-retry-authority-item-${label}-${suffix}`,
      jobId: `creative-retry-authority-job-${label}-${suffix}`,
      attemptId: `creative-retry-authority-attempt-${label}-${suffix}`,
      sourceAssetId: `creative-retry-authority-source-${label}-${suffix}`,
      pinnedWorkflowKey: overrides.pinnedWorkflowKey ?? workflowKey,
      pinnedWorkflowVersion: overrides.pinnedWorkflowVersion ?? 1,
    };
  }

  async function seedScenario(
    fixture: (typeof scenarios)[keyof typeof scenarios],
  ) {
    await prisma.mediaAsset.create({
      data: {
        id: fixture.sourceAssetId,
        ownerId: actorId,
        type: "image",
        url: `/user-content/${fixture.sourceAssetId}/content.webp`,
        storageKey: `creative-retry-authority/${suffix}/${fixture.label}.webp`,
        contentType: "image/webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.generationJob.create({
      data: {
        id: fixture.jobId,
        userId: actorId,
        mode: "image",
        controls: {
          sourceImageAssetId: fixture.sourceAssetId,
          workflowKey,
          workflowVersion: 1,
        },
        presetIds: [],
        outputCount: 1,
        status: "failed",
        errorCode: "provider_timeout",
        profileId: profileKey,
        profileVersion: 1,
        model: workflowKey,
        provider: "comfyui",
        sourceType: "content_production_item",
        sourceId: fixture.itemId,
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: fixture.attemptId,
        requestId: fixture.jobId,
        attemptNo: 1,
        provider: "comfyui",
        profileKey,
        profileVersion: 1,
        workflowKey: fixture.pinnedWorkflowKey,
        workflowVersion: fixture.pinnedWorkflowVersion,
        status: "failed",
        errorClass: "provider",
        errorCode: "provider_timeout",
        errorSignature: `comfyui:${fixture.label}:provider_timeout`,
        retryability: "retryable",
        finishedAt: new Date(),
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: fixture.runId,
        title: `Creative retry authority ${fixture.label}`,
        purpose: "campaign",
        targetType: "campaign",
        targetId: `creative-retry-authority-campaign-${fixture.label}-${suffix}`,
        profileId: profileKey,
        profileVersion: 1,
        presetIds: [],
        count: 1,
        totalItems: 1,
        failedItems: 1,
        status: "completed",
        lifecycleState: "active",
        workflowStage: "generation",
        verificationState: "pending",
        version: 1,
        createdById: actorId,
        ownerId: actorId,
        items: {
          create: {
            id: fixture.itemId,
            itemIndex: 0,
            jobId: fixture.jobId,
            status: "failed",
            tags: [],
          },
        },
      },
    });
  }

  async function acceptRetry(
    fixture: (typeof scenarios)[keyof typeof scenarios],
  ) {
    const response = await retryFailed(
      new Request(
        `http://localhost/api/v2/admin/creative/runs/${fixture.runId}/commands/retry-failed`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
            "x-request-id": `creative-retry-authority-request-${fixture.label}-${suffix}`,
            "idempotency-key": `creative-retry-authority-command-${fixture.label}-${suffix}`,
            "if-match": "\"1\"",
          },
          body: JSON.stringify({
            entityVersion: 1,
            reason: {
              code: "provider_recovered",
              summary: "Retry only after frozen media and workflow authority are revalidated",
            },
            confirmation: `${fixture.runId}:retry-failed`,
          }),
        },
      ),
      { params: Promise.resolve({ id: fixture.runId }) },
    );
    const payload = await response.json() as {
      data?: { commandId?: string };
      error?: unknown;
    };
    expect(response.status, JSON.stringify(payload)).toBe(202);
    if (!payload.data?.commandId) {
      throw new Error(`Creative retry command was not accepted for ${fixture.label}`);
    }
    commandIds.push(payload.data.commandId);
    return payload.data.commandId;
  }

  async function domainSnapshot(
    fixture: (typeof scenarios)[keyof typeof scenarios],
  ) {
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId: fixture.jobId },
      orderBy: [{ attemptNo: "asc" }, { id: "asc" }],
    });
    const [job, run, item, sourceAsset, jobEvents, attemptEvents, outbox] = await Promise.all([
      prisma.generationJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      }),
      prisma.contentProductionBatch.findUniqueOrThrow({
        where: { id: fixture.runId },
      }),
      prisma.contentProductionItem.findUniqueOrThrow({
        where: { id: fixture.itemId },
      }),
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: fixture.sourceAssetId },
      }),
      prisma.generationJobEvent.findMany({
        where: { jobId: fixture.jobId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.generationAttemptEvent.findMany({
        where: { attemptId: { in: attempts.map((attempt) => attempt.id) } },
        orderBy: [{ attemptId: "asc" }, { sequence: "asc" }],
      }),
      prisma.mainOutboxEvent.findMany({
        where: { aggregateId: fixture.runId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);
    return {
      job,
      run,
      item,
      sourceAsset,
      attempts,
      jobEvents,
      attemptEvents,
      outbox,
    };
  }

  async function expectAtomicExecutionFailure(input: {
    fixture: (typeof scenarios)[keyof typeof scenarios];
    commandId: string;
    expectedError: Record<string, unknown>;
  }) {
    const before = await domainSnapshot(input.fixture);
    await expect(
      executeCreativeRetryCommand(prisma, {
        commandId: input.commandId,
        workerId: `creative-retry-authority-worker-${input.fixture.label}-${suffix}`,
      }),
    ).rejects.toMatchObject(input.expectedError);
    await expect(domainSnapshot(input.fixture)).resolves.toEqual(before);
    await expect(
      prisma.generationAttempt.count({
        where: { sourceCommandId: input.commandId },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.mainOutboxEvent.count({
        where: {
          aggregateId: input.fixture.runId,
          eventType: "creative.retry.dispatch.v2",
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.controlPlaneCommand.findUniqueOrThrow({
        where: { id: input.commandId },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      attemptCount: 1,
      leaseOwner: null,
      error: {
        code: "creative_retry_execution_failed",
      },
    });
    await expect(
      prisma.controlPlaneCommandAttempt.findUniqueOrThrow({
        where: {
          commandId_attemptNo: {
            commandId: input.commandId,
            attemptNo: 1,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "creative_retry_execution_failed",
      },
    });
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: profileId,
        profileKey,
        label: "Creative retry Qwen image edit authority",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey,
        runnerConfig: {
          verificationStatus: "passed",
          workflowVersion: 1,
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        enabled: true,
        status: "active",
        version: 1,
        publishedAt: new Date(),
      },
    });
    for (const fixture of Object.values(scenarios)) {
      await seedScenario(fixture);
    }
  });

  afterAll(async () => {
    const fixtures = Object.values(scenarios);
    const runIds = fixtures.map((fixture) => fixture.runId);
    const jobIds = fixtures.map((fixture) => fixture.jobId);
    const sourceAssetIds = fixtures.map((fixture) => fixture.sourceAssetId);
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: runIds } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commandIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.contentProductionItem.deleteMany({
      where: { batchId: { in: runIds } },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: { in: runIds } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: jobIds } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: sourceAssetIds } },
    });
    await prisma.generationModelProfile.deleteMany({
      where: { id: profileId },
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("fails atomically when Library archives the source after command acceptance", async () => {
    const fixture = scenarios.archived;
    const commandId = await acceptRetry(fixture);
    const archiveResponse = await patchContentAsset(
      new Request(
        `http://localhost/admin/content/assets/${fixture.sourceAssetId}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `creative-retry-authority-archive-${suffix}`,
            "x-idream-user-id": actorId,
            "x-idream-role": "admin",
            "x-request-id": `creative-retry-authority-archive-${suffix}`,
          },
          body: JSON.stringify({
            status: "archived",
            reason: "Archive the failed job source after retry command acceptance",
            confirmation: fixture.sourceAssetId,
          }),
        },
      ),
      fixture.sourceAssetId,
    );
    expect(archiveResponse.status).toBe(200);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: fixture.sourceAssetId },
      }),
    ).resolves.toMatchObject({
      metadata: {
        platformAsset: {
          status: "archived",
        },
      },
    });

    await expectAtomicExecutionFailure({
      fixture,
      commandId,
      expectedError: {
        status: 409,
        details: {
          generationJobId: fixture.jobId,
          unavailableAssetIds: [fixture.sourceAssetId],
        },
      },
    });
  });

  it("fails atomically when a pinned workflow key or version drifted", async () => {
    for (const fixture of [
      scenarios.workflowKeyDrift,
      scenarios.workflowVersionDrift,
    ]) {
      const commandId = await acceptRetry(fixture);
      await expectAtomicExecutionFailure({
        fixture,
        commandId,
        expectedError: fixture === scenarios.workflowKeyDrift
          ? {
              status: 409,
              details: {
                generationJobId: fixture.jobId,
                pinnedWorkflowKey: fixture.pinnedWorkflowKey,
                effectiveWorkflowKey: workflowKey,
              },
            }
          : {
              status: 409,
              details: {
                generationJobId: fixture.jobId,
                pinnedWorkflowVersion: fixture.pinnedWorkflowVersion,
                effectiveWorkflowVersion: 1,
              },
            },
      });
    }
  });

  it("queues a retry only when the hydratable source and qwen img2img route remain valid", async () => {
    const fixture = scenarios.valid;
    const commandId = await acceptRetry(fixture);
    const executed = await executeCreativeRetryCommand(prisma, {
      commandId,
      workerId: `creative-retry-authority-worker-valid-${suffix}`,
    });

    expect(executed).toMatchObject({
      status: "verifying",
      attemptCount: 1,
      result: {
        runId: fixture.runId,
        runVersion: 2,
        itemIds: [fixture.itemId],
        verificationState: "verifying",
      },
    });
    await expect(
      prisma.generationJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      }),
    ).resolves.toMatchObject({
      status: "queued",
      version: 2,
      errorCode: null,
      controls: {
        sourceImageAssetId: fixture.sourceAssetId,
        workflowKey,
        workflowVersion: 1,
      },
    });
    await expect(
      prisma.contentProductionBatch.findUniqueOrThrow({
        where: { id: fixture.runId },
      }),
    ).resolves.toMatchObject({
      status: "queued",
      workflowStage: "generation",
      verificationState: "verifying",
      version: 2,
    });
    await expect(
      prisma.contentProductionItem.findUniqueOrThrow({
        where: { id: fixture.itemId },
      }),
    ).resolves.toMatchObject({
      status: "regenerate_requested",
      version: 2,
    });
    await expect(
      prisma.generationAttempt.findMany({
        where: { requestId: fixture.jobId },
        orderBy: { attemptNo: "asc" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: fixture.attemptId,
        attemptNo: 1,
        status: "failed",
        workflowKey,
        workflowVersion: 1,
      }),
      expect.objectContaining({
        requestId: fixture.jobId,
        attemptNo: 2,
        status: "queued",
        profileKey,
        sourceCommandId: commandId,
        creativeRunItemId: fixture.itemId,
        workflowKey,
        workflowVersion: 1,
      }),
    ]);
    await expect(
      prisma.mainOutboxEvent.findUniqueOrThrow({
        where: {
          id: `creative_retry_${commandId}_${fixture.itemId}`,
        },
      }),
    ).resolves.toMatchObject({
      eventType: "creative.retry.dispatch.v2",
      aggregateId: fixture.runId,
      status: "pending",
      attempts: 0,
      payload: {
        generationJobId: fixture.jobId,
        attemptNo: 2,
      },
    });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: fixture.sourceAssetId },
      }),
    ).resolves.toMatchObject({
      storageKey: `creative-retry-authority/${suffix}/${fixture.label}.webp`,
      safetyStatus: "passed",
      metadata: {},
    });
  });
});
