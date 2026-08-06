import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import { POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { prisma } from "@/server/lib/db";
import { getCharacterWorkspace } from "@/server/modules/admin-v2/characters/workspace";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
import { purgeQueuedGenerationJobs } from "@/server/test/helpers";
import { toInputJson } from "../shared/prisma-json";

describe("Character video Creative Run authority", () => {
  const suffix = randomUUID();
  const actorId = `character-video-actor-${suffix}`;
  const characterId = `character-video-character-${suffix}`;
  const projectId = `character-video-project-${suffix}`;
  const contentId = `character-video-content-${suffix}`;
  const revisionId = `character-video-revision-${suffix}`;
  const otherCharacterId = `character-video-other-${suffix}`;
  const publishedPrimaryAssetId = `character-video-primary-${suffix}`;
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
          visibility: "public",
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
    const compiledSoul = compileCharacterSoul({
      name: "Mara",
      age: 27,
      gender: "female",
      relationshipArchetype: "trusted companion",
      characterPromise: "A warm, self-assured companion.",
      personality: "Observant, direct, and emotionally grounded.",
      values: ["honesty"],
      wants: ["build mutual trust"],
      fears: ["breaking a confidence"],
      contradictions: ["careful but spontaneously playful"],
      backstory: "She learned dependable companionship through community work.",
      tone: "Warm and concise.",
      cadence: "Measured sentences with occasional dry humor.",
      vocabulary: ["grounded", "specific"],
      voiceHabits: ["asks one focused follow-up"],
      voiceAvoid: ["generic reassurance"],
      interaction: {
        initiative: "Offer a concrete next step.",
        curiosity: "Ask about motives, not just events.",
        pacing: "Let emotional turns breathe.",
        affection: "Show care through attentive recall.",
        conflict: "Name disagreement without escalating.",
        repair: "Acknowledge impact and propose repair.",
      },
      canon: {
        facts: ["She works with local community groups."],
        unknowns: ["The user's private history unless disclosed."],
      },
      exampleDialogue: ["I hear the decision. What part feels hardest to carry?"],
      negativeDialogue: [{
        assistant: "Everything will be fine.",
        reason: "Generic reassurance ignores the user's actual concern.",
      }],
    });
    if (!compiledSoul.ok || compiledSoul.diagnostics.length > 0) {
      throw new Error("video workspace fixture Soul must be release-complete");
    }
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: compiledSoul.snapshot.compiled.fingerprint,
        personaSnapshot: toInputJson(compiledSoul.snapshot),
        openingSnapshot: { firstMessage: "Tell me what happened." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "test",
        createdById: actorId,
      },
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { currentContentVersionId: contentId },
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
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: {},
        createdById: actorId,
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: publishedPrimaryAssetId,
          ownerId: actorId,
          characterId,
          type: "image",
          url: `https://assets.example/${publishedPrimaryAssetId}.webp`,
          storageKey: `tests/${publishedPrimaryAssetId}.webp`,
          contentType: "image/webp",
          width: 768,
          height: 1152,
          safetyStatus: "passed",
          metadata: {},
        },
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
    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: publishedPrimaryAssetId },
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
      where: {
        id: {
          in: [
            publishedPrimaryAssetId,
            sourceAssetId,
            otherSourceAssetId,
          ],
        },
      },
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

  it("dispatches an exact LTX job from an operational image that is not the published primary", async () => {
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
    expect(await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: {
        id: `creative_initial_${batchId}_${item.id}`,
      },
    })).toMatchObject({
      status: "delivered",
      lastError: null,
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
