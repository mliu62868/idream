import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AiFinalizePayload } from "@/server/ai/schemas";
import { reconcileStaleGenerationJobs } from "@/server/ai/local-pipeline";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

const P = "zt-imgsvc-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

function asInputJson(value: AiFinalizePayload): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("image generation service contract", () => {
  it("dedupes POST by Idempotency-Key and does not double reserve", async () => {
    const userId = `${P}idem-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const first = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}idem-key` },
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    const second = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}idem-key` },
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });

    expectOk(first, 202);
    expectOk(second);
    expect(second.data.job.id).toBe(first.data.job.id);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(await dreamcoinBalance(userId)).toBe(95);
    await runQueuedGenerationJobs(8);
  });

  it("enforces the per-user active job limit before reserve", async () => {
    const userId = `${P}limit-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const previous = process.env.MAX_INFLIGHT_JOBS_PER_USER;
    process.env.MAX_INFLIGHT_JOBS_PER_USER = "1";
    try {
      const first = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "image", characterId: CHAR, outputCount: 1 },
      });
      expectOk(first, 202);

      const second = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "image", characterId: CHAR, outputCount: 1 },
      });
      expectError(second, 429, "rate_limited");
      expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
      expect(await dreamcoinBalance(userId)).toBe(95);
      await runQueuedGenerationJobs(8);
    } finally {
      if (previous === undefined) delete process.env.MAX_INFLIGHT_JOBS_PER_USER;
      else process.env.MAX_INFLIGHT_JOBS_PER_USER = previous;
    }
  });

  it("reconciles stale non-terminal jobs to failed and refunds idempotently", async () => {
    const userId = `${P}stale-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { updatedAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const reconciled = await reconcileStaleGenerationJobs({
      now: new Date("2026-01-01T00:20:00.000Z"),
      timeoutMs: 60_000,
    });
    expect(reconciled.enqueued).toBeGreaterThanOrEqual(1);
    await runQueuedGenerationJobs(4);
    await runQueuedGenerationJobs(4);

    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("failed");
    expect(poll.data.job.errorCode).toBe("stale_timeout");
    expect(await dreamcoinBalance(userId)).toBe(100);
  });

  it("returns a same-origin download URL for local private storage", async () => {
    const userId = `${P}ttl-user`;
    const mediaId = `${P}media-ttl`;
    await createUser({ id: userId });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}private/image.webp`,
        contentType: "image/webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const download = await api("GET", `media/${mediaId}/download`, { userId, ageGate: true });
    expectOk(download);
    const token = Buffer.from(mediaId, "utf8").toString("base64url");
    expect(download.data.url).toBe(`/user-content/${token}/content.webp?download=1`);
  });

  it("summarizes partial success refunds in the job cost response", async () => {
    const userId = `${P}partial-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 2 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]);
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.completed",
        requestId: `${P}partial-request`,
        generationJobId: jobId,
        mode: "image",
        assets: [
          {
            key: `${P}partial/${jobId}/0.webp`,
            contentType: "image/webp",
            width: 1024,
            height: 1280,
          },
        ],
        usage: { gpuSeconds: 1.2, model: "mock-image" },
      }),
      dedupeKey: `generation-finalize:${jobId}:completed`,
    });

    await runQueuedGenerationJobs(4);
    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("completed");
    expect(poll.data.cost).toMatchObject({
      charged: 10,
      refunded: 5,
      finalCharge: 5,
      assetCount: 1,
      requestedCount: 2,
      missingOutputs: 1,
    });
    expect(await dreamcoinBalance(userId)).toBe(95);
  });

  it("folds selected built-in presets into the generation prompt", async () => {
    const userId = `${P}preset-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const preset = await prisma.generationPreset.create({
      data: {
        scope: "built_in",
        type: "background",
        label: "Bedroom",
        controls: { background: "bedroom", lighting: "soft" },
        visibility: "public",
        status: "active",
      },
    });

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
        controls: { backgroundPresetId: preset.id },
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.prompt).toContain("bedroom");
    expect(job.prompt).toContain("soft");
    await runQueuedGenerationJobs(4);
  });

  it("ignores preset ids that are not built-in or owned by the user", async () => {
    const owner = `${P}preset-owner`;
    const intruder = `${P}preset-intruder`;
    await createUser({ id: owner });
    await createUser({ id: intruder });
    await grantCoins(intruder, 100, "seed");
    const privatePreset = await prisma.generationPreset.create({
      data: {
        ownerId: owner,
        scope: "user",
        type: "outfit",
        label: "Secret",
        controls: { outfit: "secret-couture" },
        visibility: "private",
        status: "active",
      },
    });

    const gen = await api("POST", "generation/jobs", {
      userId: intruder,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
        controls: { outfitPresetId: privatePreset.id },
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.prompt).not.toContain("secret-couture");
    await runQueuedGenerationJobs(4);
  });
});
