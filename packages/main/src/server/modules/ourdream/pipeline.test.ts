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
  expectOk,
  grantCoins,
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
  await createUser({ id: SYS });
  await createCharacter({
    id: CHAR,
    creatorId: SYS,
    visibility: "public",
    status: "approved",
    systemPrompt: "Stay warm and concise.",
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
    ]);
  }
  await prisma.moderationEvent.deleteMany({
    where: { targetId: { in: cleanupModerationTargetIds } },
  });
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function requeueAsFinalAttempt(queue: "ai.image.generate" | "ai.video.generate", jobId: string) {
  const dedupeKey = `generation:${jobId}`;
  const queued = await jobQueue.getByDedupeKey(queue, dedupeKey);
  expect(queued).not.toBeNull();
  if (!queued) throw new Error(`Missing queued ${queue} job for ${jobId}`);

  await jobQueue.removeByDedupePrefix(dedupeKey, [queue]);
  await jobQueue.enqueue({
    queue,
    payload: queued.payload as Prisma.InputJsonValue,
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

    await runQueuedGenerationJobs(8);
    const completed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(completed);
    expect(completed.data.job.status).toBe("completed");
    expect(completed.data.assets).toHaveLength(2);

    const generateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `generation-finalize:${jobId}:completed`,
    );
    expect(generateJob).toMatchObject({ queue: "ai.image.generate", state: "completed" });
    expect(finalizeJob).toMatchObject({ queue: "app.ai.finalize", state: "completed" });
    expect(generateJob?.payload).toMatchObject({
      controls: {
        profileId: "profile_image_default_v1",
        width: 768,
        height: 1024,
      },
    });

    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { sourceJobId: jobId },
    });
    expect(asset.metadata).toMatchObject({
      provider: "mock-pipeline",
      contentType: "image/png",
    });
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
    expect(generateJob).toMatchObject({ queue: "ai.image.generate", state: "completed" });
    expect(finalizeJob).toMatchObject({ queue: "app.ai.finalize", state: "completed" });
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
          model: "mock-video",
          controls: expect.objectContaining({
            profileId: "profile_video_beta_v1",
            width: 768,
            height: 1024,
          }),
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
    }
  });
});
