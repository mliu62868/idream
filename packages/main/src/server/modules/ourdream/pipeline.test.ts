import { deflateSync } from "node:zlib";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { providers } from "@/server/providers";
import {
  api,
  createCharacter,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  grantCoins,
  publishCharacterForPublicAudience,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

const P = "zt-pipe-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;
const cleanupJobDedupeKeys: string[] = [];
const cleanupModerationTargetIds: string[] = [];

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS, dataClass: "customer" });
  await createCharacter({
    id: CHAR,
    creatorId: SYS,
    visibility: "public",
    status: "approved",
    systemPrompt: "Stay warm and concise.",
  });
  await prisma.characterVisualProfile.create({
    data: {
      id: `${P}bootstrap-visual-profile`,
      characterId: CHAR,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "Test Character, adult woman",
      faceTraits: {},
      hairTraits: {},
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: {},
      anchorAssetIds: [],
      referenceAssetIds: [],
      adapterRefs: {},
      createdFrom: "generation_bootstrap:test",
    },
  });
  await publishCharacterForPublicAudience({
    characterId: CHAR,
    ownerId: SYS,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const dedupeKey of cleanupJobDedupeKeys) {
    await jobQueue.removeByDedupePrefix(dedupeKey, [
      "ai.image.generate",
      "ai.video.generate",
      "app.ai.finalize",
      "character.preview",
    ]);
  }
  await prisma.moderationEvent.deleteMany({
    where: { targetId: { in: cleanupModerationTargetIds } },
  });
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function requeueAsFinalAttempt(
  queue: "ai.image.generate" | "ai.video.generate",
  jobId: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const dedupeKey = `generation:${jobId}`;
  const queued = await jobQueue.getByDedupeKey(queue, dedupeKey);
  expect(queued).not.toBeNull();
  if (!queued) throw new Error(`Missing queued ${queue} job for ${jobId}`);

  await jobQueue.removeByDedupePrefix(dedupeKey, [queue]);
  await jobQueue.enqueue({
    queue,
    payload: {
      ...(queued.payload as Record<string, unknown>),
      ...payloadPatch,
    } as Prisma.InputJsonValue,
    dedupeKey,
    maxAttempts: 1,
  });
}

describe("local AI service pipeline", () => {
  it("queues image generation and creates media through the finalize queue", async () => {
    const userId = `${P}gen-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 2 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    expect(gen.status).toBe(202);
    expect(gen.data.job.status).toBe("queued");
    expect(gen.data.assets).toHaveLength(0);

    const queuedGenerateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`);
    expect(queuedGenerateJob?.payload).toMatchObject({
      controls: {
        profileId: "profile_image_default_v1",
        width: 512,
        height: 512,
        modelCapabilities: expect.objectContaining({
          referenceImages: false,
          initImage: false,
        }),
      },
    });
    expect((queuedGenerateJob?.payload as { controls?: unknown })?.controls).not.toHaveProperty("sdcpp");

    await runQueuedGenerationJobs(8);
    const completed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(completed);
    expect(completed.data.job.status).toBe("completed");
    expect(completed.data.assets).toHaveLength(2);
    await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({
      status: "completed",
      deliveredOutputCount: 2,
      version: 5,
      finishedAt: expect.any(Date),
      completedAt: expect.any(Date),
    });
    await expect(prisma.generationSettlementLink.count({ where: { requestId: jobId } })).resolves.toBe(1);

    const generateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `generation-finalize:${jobId}:completed`,
    );
    expect(generateJob).toBeNull();
    expect(finalizeJob).toMatchObject({ queue: "app.ai.finalize", state: "completed" });
    expect(completed.data.job.controls).not.toHaveProperty("sdcpp");

    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { sourceJobId: jobId },
    });
    expect(asset.metadata).toMatchObject({
      provider: "mock",
      contentType: "image/png",
      synthetic: true,
    });
  });

  it("fails and refunds image generation when provider output is blank", async () => {
    const userId = `${P}blank-image-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const imageGenerate = vi.spyOn(providers.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: {
        assets: [
          {
            key: "pipeline/blank.png",
            width: 4,
            height: 4,
            contentType: "image/png",
            body: whitePng(4, 4),
          },
        ],
      },
    });
    const blobPut = vi.spyOn(providers.blob, "putPrivate");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(`generation:${jobId}`, `generation-finalize:${jobId}:failed`);
    cleanupModerationTargetIds.push(jobId);
    await requeueAsFinalAttempt("ai.image.generate", jobId);

    await runQueuedGenerationJobs(8);

    expect(imageGenerate).toHaveBeenCalledTimes(1);
    expect(blobPut).not.toHaveBeenCalled();
    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("failed");
    expect(poll.data.job.errorCode).toBe("asset_quality_failed");
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
    await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({
      status: "failed",
      deliveredOutputCount: 0,
      finishedAt: expect.any(Date),
      completedAt: null,
    });
    await expect(prisma.generationSettlementLink.count({ where: { requestId: jobId } })).resolves.toBe(2);
  });

  it("does not persist a multi-panel image when a single continuous frame is required", async () => {
    const userId = `${P}composite-image-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    vi.spyOn(providers.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: {
        assets: [
          {
            key: "pipeline/contact-sheet.png",
            width: 80,
            height: 100,
            contentType: "image/png",
            body: contactSheetPng(),
          },
        ],
      },
    });
    const blobPut = vi.spyOn(providers.blob, "putPrivate");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
      },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
    );
    cleanupModerationTargetIds.push(jobId);
    await requeueAsFinalAttempt("ai.image.generate", jobId, {
      controls: {
        compositionRequirement: "single_subject_single_frame",
      },
    });

    await runQueuedGenerationJobs(8);

    const poll = await api("GET", `generation/jobs/${jobId}`, {
      userId,
      ageGate: true,
    });
    expectOk(poll);
    expect(poll.data.job).toMatchObject({
      status: "failed",
      errorCode: "asset_quality_failed",
    });
    expect(blobPut).not.toHaveBeenCalled();
    expect(
      await prisma.mediaAsset.count({ where: { sourceJobId: jobId } }),
    ).toBe(0);
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } }),
    ).resolves.toMatchObject({ deliveredOutputCount: 0 });
  });

  it("keeps character preview provider work out of the main mock drain", async () => {
    const userId = `${P}preview-throw-user`;
    await createUser({ id: userId });

    const draft = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "Preview Throw", gender: "female", style: "realistic" },
    });
    expectOk(draft);
    const draftId = draft.data.draft.id as string;
    const preview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    const previewJobId = preview.data.previewJob.id as string;
    cleanupJobDedupeKeys.push(`character-preview:${previewJobId}`);

    await runQueuedGenerationJobs(4);

    const status = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(status);
    expect(status.data.previewJob).toMatchObject({
      status: "queued",
      provider: "generation_service",
    });

    const previewQueueJob = await jobQueue.getByDedupeKey(
      "character.preview",
      `character-preview:${previewJobId}`,
    );
    expect(previewQueueJob).toMatchObject({
      queue: "character.preview",
      state: "waiting",
      payload: expect.objectContaining({
        kind: "character.preview",
        previewJobId,
        draftId,
        userId,
        model: expect.not.stringContaining("mock"),
      }),
    });
  });

  it("settles a generation-service character preview failure through main authority", async () => {
    const userId = `${P}preview-no-body-user`;
    await createUser({ id: userId });

    const draft = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "Preview Missing Bytes", gender: "female", style: "realistic" },
    });
    expectOk(draft);
    const draftId = draft.data.draft.id as string;
    const preview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    const previewJobId = preview.data.previewJob.id as string;
    cleanupJobDedupeKeys.push(
      `character-preview:${previewJobId}`,
      `character-preview-finalize:${previewJobId}:failed`,
    );
    await jobQueue.removeByDedupePrefix(
      `character-preview:${previewJobId}`,
      ["character.preview"],
    );
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: {
        version: 1,
        kind: "character.preview.failed",
        requestId: `character-preview:${previewJobId}`,
        previewJobId,
        draftId,
        userId,
        error: {
          code: "preview_provider_down",
          message: "Image backend unavailable",
          retryable: false,
        },
      },
      dedupeKey: `character-preview-finalize:${previewJobId}:failed`,
    });

    await runQueuedGenerationJobs(4);

    const status = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(status);
    expect(status.data.previewJob).toMatchObject({
      status: "failed",
      errorCode: "preview_provider_down",
    });
    expect(status.data.asset).toBeNull();
  });

  it("fails and refunds image jobs when generated assets cannot be persisted", async () => {
    const userId = `${P}blob-fail-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    await requeueAsFinalAttempt("ai.image.generate", jobId);
    vi.spyOn(providers.blob, "putPrivate").mockResolvedValueOnce({
      ok: false,
      error: {
        code: "blob_write_failed",
        message: "object store unavailable",
        retryable: true,
      },
    });

    await runQueuedGenerationJobs(8);

    const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(failed);
    expect(failed.data.job.status).toBe("failed");
    expect(failed.data.job.errorCode).toBe("asset_persist_failed");
    expect(failed.data.assets).toHaveLength(0);
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);

    const generateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `generation-finalize:${jobId}:failed`,
    );
    expect(generateJob).toBeNull();
    expect(finalizeJob).toMatchObject({ queue: "app.ai.finalize", state: "completed" });
  });

  it("fails and refunds image jobs when the provider returns keys without asset bytes", async () => {
    const userId = `${P}image-no-body-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    await requeueAsFinalAttempt("ai.image.generate", jobId);
    vi.spyOn(providers.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: {
        assets: [{
          key: "provider/image-without-body.png",
          width: 1024,
          height: 1024,
          contentType: "image/png",
        }],
      },
    });
    const blobPut = vi.spyOn(providers.blob, "putPrivate");

    await runQueuedGenerationJobs(8);

    const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(failed);
    expect(failed.data.job).toMatchObject({
      status: "failed",
      errorCode: "asset_body_missing",
    });
    expect(failed.data.assets).toHaveLength(0);
    expect(blobPut).not.toHaveBeenCalled();
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
  });

  it("fails empty image provider results without charging the user", async () => {
    const userId = `${P}empty-result-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    vi.spyOn(providers.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: { assets: [] },
    });

    await runQueuedGenerationJobs(8);

    const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(failed);
    expect(failed.data.job.status).toBe("failed");
    expect(failed.data.job.errorCode).toBe("empty_provider_result");
    expect(failed.data.assets).toHaveLength(0);
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
  });

  it("passes video context to the provider and fails when the video asset cannot be persisted", async () => {
    const userId = `${P}video-blob-fail`;
    await createUser({ id: userId });
    await grantCoins(userId, 300, "seed");
    await prisma.entitlement.create({
      data: { userId, key: "video_generation", value: true, source: "test" },
    });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    const previousVideoProfile =
      await prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { rolloutPercent: true },
      });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });

    try {
      const originalVideoGenerate = providers.video.generate.bind(providers.video);
      const videoSpy = vi
        .spyOn(providers.video, "generate")
        .mockImplementation((input) => originalVideoGenerate(input));
      vi.spyOn(providers.blob, "putPrivate").mockResolvedValueOnce({
        ok: false,
        error: {
          code: "blob_write_failed",
          message: "object store unavailable",
          retryable: true,
        },
      });

      const gen = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "video", characterId: CHAR, outputCount: 1 },
      });
      expectOk(gen, 202);
      const jobId = gen.data.job.id as string;
      cleanupJobDedupeKeys.push(
        `generation:${jobId}`,
        `generation-finalize:${jobId}:failed`,
        `generation-finalize:${jobId}:completed`,
      );
      cleanupModerationTargetIds.push(jobId);

      await requeueAsFinalAttempt("ai.video.generate", jobId);
      await runQueuedGenerationJobs(8);

      expect(videoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Video generation for Test Character",
          seconds: 4,
          seed: expect.any(String),
          negativePrompt: null,
          model: "ltx23-gtanimation-i2v",
          controls: expect.objectContaining({
            profileId: "profile_video_beta_v1",
            width: 768,
            height: 1152,
            sourceImageAssetId: expect.any(String),
            workflowKey: "ltx23-gtanimation-i2v",
            workflowVersion: 1,
          }),
          referenceImages: [
            expect.objectContaining({
              assetId: expect.any(String),
              role: "source_image",
            }),
          ],
          requestId: expect.any(String),
        }),
      );

      const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
      expectOk(failed);
      expect(failed.data.job.status).toBe("failed");
      expect(failed.data.job.errorCode).toBe("asset_persist_failed");
      expect(failed.data.assets).toHaveLength(0);
      expect(await dreamcoinBalance(userId)).toBe(300);
      expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: { enabled: false, rolloutPercent: 0 },
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: previousVideoProfile,
      });
    }
  });

  it("rejects non-four-second requests and unpublished Character sources", async () => {
    const userId = `${P}video-authority-user`;
    const privateCharacterId = `${P}private-video-char`;
    const privateAssetId = `${P}private-video-source`;
    const alternateProfileKey = `${P}alternate-video-profile`;
    await createUser({ id: userId });
    await grantCoins(userId, 300, "seed");
    await prisma.entitlement.createMany({
      data: [
        { userId, key: "video_generation", value: true, source: "test" },
        { userId, key: "premium_controls", value: true, source: "test" },
      ],
    });
    await createCharacter({
      id: privateCharacterId,
      creatorId: userId,
      source: "user",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: privateAssetId,
        ownerId: userId,
        characterId: privateCharacterId,
        type: "image",
        storageKey: `${P}private-video-source.webp`,
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {
          synthetic: false,
          platformAsset: { status: "active" },
        },
      },
    });
    await prisma.character.update({
      where: { id: privateCharacterId },
      data: { imageAssetId: privateAssetId },
    });
    const previousFlag = await prisma.featureFlag.findUniqueOrThrow({
      where: { key: "video_gen" },
      select: { enabled: true, rolloutPercent: true },
    });
    const previousVideoProfile =
      await prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { rolloutPercent: true },
      });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: alternateProfileKey,
        profileKey: alternateProfileKey,
        label: "Unauthorized alternate video route",
        mode: "video",
        runner: "comfyui",
        pipelineModel: "ltx23-gtanimation-int4-convrot",
        workflowKey: "ltx23-gtanimation-i2v",
        runnerConfig: {
          capabilities: { initImage: true, imageToVideo: true },
        },
        defaultWidth: 768,
        defaultHeight: 1152,
        allowedOrientations: ["2:3"],
        costMultiplier: 0.1,
        requiredEntitlement: "video_generation",
        maxCount: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
      },
    });

    try {
      const config = await api("GET", "generation/config", {
        userId,
        ageGate: true,
      });
      expectOk(config);
      expect(config.data.video.models).toHaveLength(1);
      expect(config.data.video.models[0].id).toBe(
        "profile_video_beta_v1",
      );
      const alternateRoute = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: CHAR,
          model: alternateProfileKey,
          controls: { seconds: 4 },
          outputCount: 1,
        },
      });
      expectError(alternateRoute, 409, "conflict");

      const invalidDuration = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: CHAR,
          controls: { seconds: 6 },
          outputCount: 1,
        },
      });
      expectError(invalidDuration, 400, "bad_request");

      const unpublished = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: privateCharacterId,
          controls: { seconds: 4 },
          outputCount: 1,
        },
      });
      expectError(unpublished, 404, "not_found");
      await expect(
        prisma.generationJob.count({
          where: { userId, mode: "video" },
        }),
      ).resolves.toBe(0);
      await expect(dreamcoinBalance(userId)).resolves.toBe(300);
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: previousFlag,
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: previousVideoProfile,
      });
    }
  });

  it("fails closed when a video retry no longer matches its pinned workflow", async () => {
    const userId = `${P}video-retry-authority-user`;
    const retryKey = `${P}video-retry-authority-key`;
    await createUser({ id: userId });
    await grantCoins(userId, 300, "seed");
    await prisma.entitlement.create({
      data: { userId, key: "video_generation", value: true, source: "test" },
    });
    const previousFlag = await prisma.featureFlag.findUniqueOrThrow({
      where: { key: "video_gen" },
      select: { enabled: true, rolloutPercent: true },
    });
    const previousVideoProfile =
      await prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { rolloutPercent: true },
      });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });

    try {
      const created = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: CHAR,
          controls: { seconds: 4 },
          outputCount: 1,
        },
      });
      expectOk(created, 202);
      const failedJobId = created.data.job.id as string;
      cleanupJobDedupeKeys.push(`generation:${failedJobId}`);
      await jobQueue.removeByDedupePrefix(
        `generation:${failedJobId}`,
        ["ai.video.generate"],
      );
      const originalControls = created.data.job.controls as Record<
        string,
        unknown
      >;
      await prisma.generationJob.update({
        where: { id: failedJobId },
        data: {
          status: "failed",
          errorCode: "video_retry_fixture",
          controls: {
            ...originalControls,
            workflowVersion: 2,
          } as Prisma.InputJsonValue,
        },
      });

      const staleQuote = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry/quote`,
        {
          userId,
          ageGate: true,
          body: {},
        },
      );
      expectError(staleQuote, 409, "conflict");

      await prisma.generationJob.update({
        where: { id: failedJobId },
        data: { controls: originalControls as Prisma.InputJsonValue },
      });
      const quoted = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry/quote`,
        {
          userId,
          ageGate: true,
          body: {},
        },
      );
      expectOk(quoted);
      const retried = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry`,
        {
          userId,
          ageGate: true,
          headers: { "idempotency-key": retryKey },
          body: {
            quoteAuthority: {
              profileId: quoted.data.quote.profileId,
              profileVersion: quoted.data.quote.profileVersion,
              routeFingerprint: quoted.data.quote.routeFingerprint,
              pricingFingerprint: quoted.data.quote.pricing.fingerprint,
              outputCount: quoted.data.quote.outputCount,
              costDreamcoins: quoted.data.quote.costDreamcoins,
            },
          },
        },
      );
      expectOk(retried, 202);
      expect(retried.data.job.controls).toMatchObject({
        workflowKey: "ltx23-gtanimation-i2v",
        workflowVersion: 1,
      });
      cleanupJobDedupeKeys.push(`generation:${retried.data.job.id as string}`);
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: previousFlag,
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: previousVideoProfile,
      });
    }
  });

  it("serves generated video bytes instead of an unrelated image placeholder", async () => {
    const userId = `${P}video-success`;
    await createUser({ id: userId });
    await grantCoins(userId, 300, "seed");
    await prisma.entitlement.create({
      data: { userId, key: "video_generation", value: true, source: "test" },
    });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    const previousVideoProfile =
      await prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { rolloutPercent: true },
      });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });

    try {
      const gen = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "video", characterId: CHAR, outputCount: 1 },
      });
      expectOk(gen, 202);
      const jobId = gen.data.job.id as string;
      cleanupJobDedupeKeys.push(
        `generation:${jobId}`,
        `generation-finalize:${jobId}:completed`,
      );
      cleanupModerationTargetIds.push(jobId);

      await runQueuedGenerationJobs(8);

      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { sourceJobId: jobId },
      });
      expect(asset.type).toBe("video");
      expect(asset.url).toMatch(/^\/user-content\/.+\/content\.mp4$/);
      expect(asset.thumbnailUrl).toBeNull();
      expect(asset.url).not.toContain("promo-card");
      expect(asset.metadata).toMatchObject({
        provider: "mock",
        synthetic: true,
      });
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: { enabled: false, rolloutPercent: 0 },
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: previousVideoProfile,
      });
    }
  });
});

function whitePng(width: number, height: number) {
  const rows = Array.from({ length: height }, () => {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function contactSheetPng() {
  const width = 80;
  const height = 100;
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const thumbnail = Math.floor(y / 25);
      const color: [number, number, number] = x < 60
        ? [
            (x * 3 + y) % 180,
            (x + y * 2) % 180,
            (x * 2 + y * 3) % 180,
          ]
        : [
            220 - thumbnail * 20,
            190 - thumbnail * 10,
            160 + ((x + y) % 40),
          ];
      row[offset] = color[0];
      row[offset + 1] = color[1];
      row[offset + 2] = color[2];
    }
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(chunk), 0);
  return Buffer.concat([length, chunk, crc]);
}

const pngCrcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = pngCrcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
