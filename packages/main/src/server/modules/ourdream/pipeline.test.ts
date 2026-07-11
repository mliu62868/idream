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
      "character.preview",
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

async function requeuePreviewAsFinalAttempt(previewJobId: string) {
  const dedupeKey = `character.preview:${previewJobId}`;
  const queued = await jobQueue.getByDedupeKey("character.preview", dedupeKey);
  expect(queued).not.toBeNull();
  if (!queued) throw new Error(`Missing queued character.preview job for ${previewJobId}`);

  await jobQueue.removeByDedupePrefix(dedupeKey, ["character.preview"]);
  await jobQueue.enqueue({
    queue: "character.preview",
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
      version: 2,
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
      provider: "mock-pipeline",
      contentType: "image/png",
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

  it("settles async character preview as failed when the worker throws on its final attempt", async () => {
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
    cleanupJobDedupeKeys.push(`character.preview:${previewJobId}`);

    await requeuePreviewAsFinalAttempt(previewJobId);
    vi.spyOn(providers.image, "generate").mockRejectedValueOnce(new Error("preview provider down"));

    await runQueuedGenerationJobs(4);

    const status = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(status);
    expect(status.data.previewJob).toMatchObject({
      status: "failed",
      errorCode: "preview_worker_error",
    });

    const previewQueueJob = await jobQueue.getByDedupeKey(
      "character.preview",
      `character.preview:${previewJobId}`,
    );
    expect(previewQueueJob).toMatchObject({ queue: "character.preview", state: "completed" });
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
