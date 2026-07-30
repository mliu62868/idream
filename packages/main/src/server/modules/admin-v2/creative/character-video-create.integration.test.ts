import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { prisma } from "@/server/lib/db";
import { getCharacterWorkspace } from "@/server/modules/admin-v2/characters/workspace";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
import { purgeQueuedGenerationJobs } from "@/server/test/helpers";

describe("Character video Creative Run authority", () => {
  const suffix = randomUUID();
  const actorId = `character-video-actor-${suffix}`;
  const characterId = `character-video-character-${suffix}`;
  const projectId = `character-video-project-${suffix}`;
  const otherCharacterId = `character-video-other-${suffix}`;
  const sourceAssetId = `character-video-source-${suffix}`;
  const otherSourceAssetId = `character-video-other-source-${suffix}`;
  const batchIds: string[] = [];

  function request(
    overrides: Record<string, unknown> = {},
    key = `character-video-create-${suffix}`,
  ) {
    return new Request("http://localhost/api/v2/admin/creative/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        title: "Mara motion portrait",
        purpose: "character_video",
        targetType: "character",
        targetId: characterId,
        profileId: "profile_video_beta_v1",
        referenceAssetIds: [sourceAssetId],
        orientation: "2:3",
        count: 1,
        brief: "A subtle natural smile with direct eye contact and a steady camera.",
        consistencyMode: "balanced",
        priority: "normal",
        reason: "Create one reviewable Character video candidate",
        ...overrides,
      }),
    });
  }

  beforeAll(async () => {
    const profile = await prisma.generationModelProfile.findFirst({
      where: {
        profileKey: "profile_video_beta_v1",
        version: 1,
      },
    });
    expect(profile && isProductionLtxVideoProfile(profile)).toBe(true);
    expect(await prisma.generationRecipe.count({
      where: {
        mode: "video",
        useCase: "character",
        status: "active",
      },
    })).toBeGreaterThan(0);

    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@idream.internal`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.character.createMany({
      data: [
        {
          id: characterId,
          creatorId: actorId,
          name: "Mara",
          age: 27,
          description: "A warm, self-assured companion.",
          status: "approved",
          source: "official",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: otherCharacterId,
          creatorId: actorId,
          name: "Other",
          age: 28,
          description: "A separate Character.",
          status: "approved",
          source: "official",
          appearance: {},
          advancedDetails: {},
        },
      ],
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "producing",
        audience: {},
        successCriteria: ["Video preserves the Character identity"],
        activeKey: `character-video:${characterId}`,
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: sourceAssetId,
          ownerId: actorId,
          characterId,
          type: "image",
          url: `https://assets.example/${sourceAssetId}.webp`,
          storageKey: `tests/${sourceAssetId}.webp`,
          contentType: "image/webp",
          width: 768,
          height: 1152,
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: otherSourceAssetId,
          ownerId: actorId,
          characterId: otherCharacterId,
          type: "image",
          url: `https://assets.example/${otherSourceAssetId}.webp`,
          storageKey: `tests/${otherSourceAssetId}.webp`,
          contentType: "image/webp",
          width: 768,
          height: 1152,
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
  });

  afterAll(async () => {
    const items = await prisma.contentProductionItem.findMany({
      where: { batchId: { in: batchIds } },
      select: { jobId: true },
    });
    const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
    await purgeQueuedGenerationJobs(jobIds);
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: batchIds } },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attempt: { requestId: { in: jobIds } } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: { in: jobIds } },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: { in: batchIds } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: jobIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId, commandType: "creative.run.create" },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: [sourceAssetId, otherSourceAssetId] } },
    });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({
      where: { id: { in: [characterId, otherCharacterId] } },
    });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("exposes every operational Character image as a video source", async () => {
    const workspace = await getCharacterWorkspace(characterId);
    expect(workspace.visual.videoSources).toContainEqual(
      expect.objectContaining({
        mediaAssetId: sourceAssetId,
        available: true,
      }),
    );
  });

  it("queues one exact LTX 2.3 image-to-video job with its source role pinned", async () => {
    const response = await createCreativeRun(request());
    expect(response.status).toBe(202);
    const payload = await response.json();
    const batchId = payload.data.batch.id as string;
    batchIds.push(batchId);

    const item = await prisma.contentProductionItem.findFirstOrThrow({
      where: { batchId },
      include: { job: true },
    });
    const attempts = await prisma.generationAttempt.findMany({
      where: { requestId: item.jobId ?? "" },
    });
    expect(item.job).toMatchObject({
      mode: "video",
      characterId,
      profileId: "profile_video_beta_v1",
      profileVersion: 1,
      recipeId: "template_video_character_default",
      orientation: "2:3",
      outputCount: 1,
      model: "ltx23-gtanimation-i2v",
      provider: "comfyui",
    });
    expect(item.job?.controls).toMatchObject({
      sourceImageAssetId: sourceAssetId,
      seconds: 4,
      width: 768,
      height: 1152,
    });
    expect(item.job?.referenceAssetIds).toEqual([sourceAssetId]);
    expect(item.job?.referenceManifest).toEqual([
      expect.objectContaining({
        mediaAssetId: sourceAssetId,
        role: "source_image",
      }),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      profileKey: "profile_video_beta_v1",
      profileVersion: 1,
      workflowKey: "ltx23-gtanimation-i2v",
      workflowVersion: 1,
    });
  });

  it("rejects a source image owned by another Character without creating a Run", async () => {
    const response = await createCreativeRun(request(
      { referenceAssetIds: [otherSourceAssetId] },
      `character-video-other-source-${suffix}`,
    ));
    expect(response.status).toBe(400);
    expect(await prisma.contentProductionBatch.count({
      where: {
        targetId: characterId,
        purpose: "character_video",
        id: { notIn: batchIds },
      },
    })).toBe(0);
  });
});
