import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import {
  createUser,
  purgeQueuedGenerationJobs,
  purgeTestData,
} from "@/server/test/helpers";

const prefix = "zt-purge-queue-";

beforeAll(async () => {
  await purgeTestData(prefix);
});

afterAll(async () => {
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

describe("purgeTestData generation queue ownership", () => {
  it("removes random-id work and finalize jobs before the owning user cascades", async () => {
    const userId = `${prefix}owner`;
    await createUser({ id: userId });
    const generationJob = await prisma.generationJob.create({
      data: {
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
      },
    });
    const workKey = `generation:${generationJob.id}`;
    const finalizeKey = `generation-finalize:${generationJob.id}:completed`;

    await jobQueue.enqueue({
      queue: "ai.image.generate",
      payload: { generationJobId: generationJob.id },
      dedupeKey: workKey,
    });
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: { generationJobId: generationJob.id },
      dedupeKey: finalizeKey,
    });

    expect(await jobQueue.getByDedupeKey("ai.image.generate", workKey)).not.toBeNull();
    expect(await jobQueue.getByDedupeKey("app.ai.finalize", finalizeKey)).not.toBeNull();

    await purgeTestData(prefix);

    expect(
      await prisma.generationJob.findUnique({ where: { id: generationJob.id } }),
    ).toBeNull();
    expect(await jobQueue.getByDedupeKey("ai.image.generate", workKey)).toBeNull();
    expect(await jobQueue.getByDedupeKey("app.ai.finalize", finalizeKey)).toBeNull();
  });

  it("removes attempt-scoped work by generation id without touching another job", async () => {
    const generationJobId = `${prefix}attempt-owner`;
    const otherGenerationJobId = `${prefix}other-owner`;
    const workKey = `generation:${generationJobId}:attempt:2`;
    const finalizeKey = `generation-finalize:${generationJobId}:completed`;
    const otherWorkKey = `generation:${otherGenerationJobId}:attempt:1`;

    await jobQueue.enqueue({
      queue: "ai.image.generate",
      payload: { generationJobId },
      dedupeKey: workKey,
    });
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: { generationJobId },
      dedupeKey: finalizeKey,
    });
    await jobQueue.enqueue({
      queue: "ai.image.generate",
      payload: { generationJobId: otherGenerationJobId },
      dedupeKey: otherWorkKey,
    });

    await expect(purgeQueuedGenerationJobs([generationJobId])).resolves.toBe(2);
    expect(await jobQueue.getByDedupeKey("ai.image.generate", workKey)).toBeNull();
    expect(await jobQueue.getByDedupeKey("app.ai.finalize", finalizeKey)).toBeNull();
    expect(
      await jobQueue.getByDedupeKey("ai.image.generate", otherWorkKey),
    ).not.toBeNull();

    await purgeQueuedGenerationJobs([otherGenerationJobId]);
  });
});
