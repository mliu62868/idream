import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import {
  api,
  createCharacter,
  createUser,
  expectOk,
  grantCoins,
  purgeTestData,
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
    expectOk(gen);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    expect(gen.data.job.status).toBe("completed");
    expect(gen.data.assets).toHaveLength(2);

    const generateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `generation-finalize:${jobId}:completed`,
    );
    expect(generateJob).toMatchObject({ queue: "ai.image.generate", state: "completed" });
    expect(finalizeJob).toMatchObject({ queue: "app.ai.finalize", state: "completed" });

    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { sourceJobId: jobId },
    });
    expect(asset.metadata).toMatchObject({
      provider: "mock-pipeline",
      contentType: "image/webp",
    });
  });
});
