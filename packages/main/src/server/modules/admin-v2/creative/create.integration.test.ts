import { randomUUID } from "node:crypto";
import { creativeRunCreateRequestSchema } from "@idream/shared/admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { createProductionBatchCore } from "@/server/modules/admin/content-ops";
import { createUser } from "@/server/test/helpers";
import { getCreativeRunDetail } from "./workflow";

describe("Creative Run v2 brief and launch", () => {
  const suffix = randomUUID();
  const actorId = `creative-create-${suffix}`;
  const idempotencyKey = `creative-create-key-${suffix}`;
  const profileKey = `creative-create-profile-${suffix}`;
  const recipeKey = `creative-create-recipe-${suffix}`;
  const replayAuthorityAssetId = `creative-create-replay-authority-${suffix}`;
  const staleOutboxIds = Array.from({ length: 3 }, (_, index) => `creative-create-stale-${suffix}-${index}`);
  let batchId: string | null = null;
  let body: Record<string, unknown>;

  function request(payload = body) {
    return new Request("http://localhost/api/v2/admin/creative/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin", dataClass: "internal" });
    await prisma.generationModelProfile.create({
      data: {
        id: `${profileKey}-v1`,
        profileKey,
        label: "Creative create integration",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "redcraft-krea2-txt2img",
        workflowKey: "redcraft-krea2-txt2img",
        runnerConfig: {
          workflowVersion: 1,
          capabilities: { textToImage: true },
        },
        allowedOrientations: ["1:1", "16:9"],
        version: 1,
        status: "active",
        enabled: true,
        rolloutPercent: 100,
        publishedAt: new Date(),
      },
    });
    await prisma.generationRecipe.create({
      data: {
        id: `${recipeKey}-v1`,
        recipeKey,
        label: "Creative create freeplay",
        mode: "image",
        useCase: "freeplay",
        body: "Create a coherent editorial image.",
        presetOrder: [],
        safetyHints: {},
        sampleMatrix: [],
        version: 1,
        status: "active",
        publishedAt: new Date(),
      },
    });
    body = {
      title: "Explicit operator brief",
      purpose: "feed",
      targetType: "none",
      profileId: profileKey,
      recipeId: recipeKey,
      presetIds: [],
      count: 2,
      brief: "Two editorial feed candidates with a coherent visual direction.",
      consistencyMode: "balanced",
      priority: "high",
      reason: "Launch a traceable Creative Run from the approved brief",
    };
    await prisma.mainOutboxEvent.createMany({
      data: staleOutboxIds.map((id) => ({
        id,
        eventType: "creative.generation.dispatch.v2",
        aggregateType: "creative_run",
        aggregateId: `stale-${suffix}`,
        payload: {},
      })),
    });
  });

  afterAll(async () => {
    if (batchId) {
      const items = await prisma.contentProductionItem.findMany({
        where: { batchId },
        select: { jobId: true },
      });
      const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
      for (const jobId of jobIds) {
        await jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]);
      }
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: batchId } });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attempt: { requestId: { in: jobIds } } },
      });
      await prisma.mediaAsset.deleteMany({
        where: { id: replayAuthorityAssetId },
      });
      await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
      await prisma.contentProductionBatch.deleteMany({ where: { id: batchId } });
      await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    }
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId, commandType: "creative.run.create" },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { id: { in: staleOutboxIds } } });
    await prisma.generationRecipe.deleteMany({ where: { recipeKey } });
    await prisma.generationModelProfile.deleteMany({ where: { profileKey } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("atomically creates lineage and replays the same idempotent brief", async () => {
    const first = await createCreativeRun(request());
    expect(first.status).toBe(202);
    const firstPayload = await first.json();
    batchId = firstPayload.data.batch.id as string;
    expect(firstPayload.data).toMatchObject({ replayed: false, batch: { id: batchId } });
    expect(await prisma.contentProductionItem.count({ where: { batchId } })).toBe(2);
    const items = await prisma.contentProductionItem.findMany({ where: { batchId } });
    const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
    expect(await prisma.generationAttempt.count({ where: { requestId: { in: jobIds } } })).toBe(2);
    expect(await prisma.generationAttempt.findMany({
      where: { requestId: { in: jobIds } },
      select: { workflowKey: true, workflowVersion: true },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowKey: expect.any(String), workflowVersion: expect.any(Number) }),
    ]));
    expect(await prisma.mainOutboxEvent.count({
      where: {
        aggregateId: batchId,
        eventType: "creative.generation.dispatch.v2",
        status: "delivered",
      },
    })).toBe(2);
    expect(await prisma.mainOutboxEvent.count({
      where: { id: { in: staleOutboxIds }, status: "pending" },
    })).toBe(3);

    await prisma.generationModelProfile.update({
      where: { id: `${profileKey}-v1` },
      data: { enabled: false, status: "archived", archivedAt: new Date() },
    });
    const replayAuthorityJobId = jobIds[0];
    expect(replayAuthorityJobId).toBeDefined();
    await prisma.generationJob.update({
      where: { id: replayAuthorityJobId },
      data: {
        provider: "mock-image",
        status: "completed",
        completedAt: new Date(),
      },
    });
    await prisma.generationAttempt.updateMany({
      where: { requestId: replayAuthorityJobId },
      data: {
        provider: "mock-image",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: replayAuthorityAssetId,
        ownerId: actorId,
        sourceJobId: replayAuthorityJobId,
        type: "image",
        url: `memory://${replayAuthorityAssetId}`,
        safetyStatus: "passed",
        metadata: { synthetic: false },
      },
    });
    await prisma.contentProductionItem.updateMany({
      where: { batchId, jobId: replayAuthorityJobId },
      data: {
        mediaAssetId: replayAuthorityAssetId,
        status: "generated",
      },
    });
    const replay = await createProductionBatchCore(
      request(),
      { id: actorId, role: "admin" },
      creativeRunCreateRequestSchema.parse(body),
    );
    expect(replay.status).toBe(200);
    const replayPayload = await replay.json();
    await prisma.generationModelProfile.update({
      where: { id: `${profileKey}-v1` },
      data: { enabled: true, status: "active", archivedAt: null },
    });
    expect(replayPayload).toMatchObject({
      data: {
        replayed: true,
        batch: {
          id: batchId,
          items: expect.arrayContaining([
            expect.objectContaining({
              jobId: replayAuthorityJobId,
              asset: expect.objectContaining({
                id: replayAuthorityAssetId,
                customerPublishable: false,
                publishabilityReasons: expect.arrayContaining([
                  "job_provider_mock",
                  "latest_attempt_provider_mock",
                ]),
              }),
            }),
          ]),
        },
      },
    });
    const replayedAuthorityItem = replayPayload.data.batch.items.find(
      (item: { jobId: string | null }) => item.jobId === replayAuthorityJobId,
    );
    expect(replayedAuthorityItem.asset.publishabilityReasons).not.toContain(
      "latest_successful_attempt_provider_missing",
    );
    expect(await prisma.contentProductionBatch.count({ where: { id: batchId } })).toBe(1);
    expect(await prisma.contentProductionItem.count({ where: { batchId } })).toBe(2);
  });

  it("rejects reuse of the idempotency key for a different brief", async () => {
    const response = await createCreativeRun(request({ ...body, count: 3 }));
    expect(response.status).toBe(409);
  });

  it("rejects generic reference assets instead of silently dropping them", async () => {
    const response = await createCreativeRun(new Request(
      "http://localhost/api/v2/admin/creative/runs",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `${idempotencyKey}-generic-reference`,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify({
          ...body,
          referenceAssetIds: ["generic-reference-that-must-not-be-ignored"],
        }),
      },
    ));
    expect(response.status).toBe(400);
  });

  it("rejects targeted generic Runs before creating production lineage", async () => {
    const targetedKey = `${idempotencyKey}-targeted-generic`;
    const beforeCount = await prisma.contentProductionBatch.count();
    const response = await createCreativeRun(new Request(
      "http://localhost/api/v2/admin/creative/runs",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": targetedKey,
          "x-idream-user-id": actorId,
          "x-idream-role": "admin",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify({
          ...body,
          targetType: "character",
          targetId: `character-that-must-not-be-targeted-${suffix}`,
        }),
      },
    ));

    expect(response.status).toBe(400);
    expect(await prisma.contentProductionBatch.count()).toBe(beforeCount);
    expect(await prisma.controlPlaneCommand.count({
      where: { idempotencyKey: targetedKey },
    })).toBe(0);
  });

  it("persists selected directions as immutable item lineage inside one Run", async () => {
    const directionKey = `${idempotencyKey}-directions`;
    const directedRequest = new Request("http://localhost/api/v2/admin/creative/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": directionKey,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        ...body,
        count: 1,
        directions: [
          {
            id: "direction-intimate",
            title: "Intimate close-up",
            scenePrompt: "A quiet close portrait with an emotionally readable gesture.",
            mood: "warm",
            setting: "window seat",
            outfit: "soft knitwear",
            camera: "85mm close portrait",
            lighting: "soft directional light",
          },
          {
            id: "direction-story",
            title: "Environmental story",
            scenePrompt: "A wider environmental portrait that reveals the story context.",
            mood: "reflective",
            setting: "late-night studio",
            outfit: "tailored casualwear",
            camera: "35mm environmental portrait",
            lighting: "practical lights and a gentle key",
          },
        ],
        outputsPerDirection: 2,
      }),
    });

    const response = await createCreativeRun(directedRequest);
    expect(response.status).toBe(202);
    const payload = await response.json();
    const directedBatchId = payload.data.batch.id as string;
    const items = await prisma.contentProductionItem.findMany({
      where: { batchId: directedBatchId },
      orderBy: { itemIndex: "asc" },
      select: { directionId: true, directionSnapshot: true, directionHash: true, jobId: true },
    });
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.directionId)).toEqual([
      "direction-intimate",
      "direction-intimate",
      "direction-story",
      "direction-story",
    ]);
    expect(items.every((item) => typeof item.directionHash === "string" && item.directionHash.length > 20)).toBe(true);
    expect(items[0]?.directionSnapshot).toMatchObject({ title: "Intimate close-up" });
    const detail = await getCreativeRunDetail({
      runId: directedBatchId,
      actor: { id: actorId, role: "admin" },
    });
    expect(detail).toMatchObject({
      reviewContext: {
        brief: body.brief,
        profile: {
          key: profileKey,
          version: 1,
          label: "Creative create integration",
        },
        recipe: {
          key: recipeKey,
          version: 1,
          label: "Creative create freeplay",
        },
        referenceAssetCount: 0,
      },
    });
    expect(detail.items[0]).toMatchObject({
      direction: {
        title: "Intimate close-up",
        scenePrompt: "A quiet close portrait with an emotionally readable gesture.",
      },
    });
    expect(detail.items[2]).toMatchObject({
      direction: {
        title: "Environmental story",
        scenePrompt: "A wider environmental portrait that reveals the story context.",
      },
    });

    const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: directedBatchId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attempt: { requestId: { in: jobIds } } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.contentProductionBatch.delete({ where: { id: directedBatchId } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { scope: { contains: "creative.run.create" }, idempotencyKey: directionKey } });
  });
});
