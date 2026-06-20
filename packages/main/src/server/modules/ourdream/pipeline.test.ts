import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
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
      "ai.memory.sync",
      "ai.memory.forget",
      "ai.memory.rebuild",
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

  it("rebuilds memory runtime state from an authoritative snapshot", async () => {
    const userId = `${P}rebuild-user`;
    await createUser({ id: userId });
    const oldMemory = await prisma.companionMemory.create({
      data: {
        id: `${P}old-memory`,
        userId,
        characterId: CHAR,
        scope: "character",
        type: "preference",
        text: "User likes stale context.",
        confidence: 0.9,
        status: "active",
        sourceMessageIds: [],
      },
    });

    await jobQueue.enqueue({
      queue: "ai.memory.rebuild",
      payload: {
        version: 1,
        kind: "memory.rebuild",
        requestId: `${P}memory-rebuild`,
        userId,
        characterId: CHAR,
        source: {
          memorySnapshotVersion: 2,
          memories: [
            {
              id: `${P}new-memory`,
              scope: "character",
              type: "preference",
              text: "User likes fresh context.",
              confidence: 0.92,
              sourceMessageIds: [],
            },
          ],
        },
      },
      dedupeKey: `${P}memory-rebuild`,
    });
    cleanupJobDedupeKeys.push(`${P}memory-rebuild`);

    const drained = await drainLocalAiPipeline({
      queues: ["ai.memory.rebuild"],
      limit: 1,
    });
    expect(drained.processed).toBe(1);

    const stale = await prisma.companionMemory.findUnique({ where: { id: oldMemory.id } });
    const fresh = await prisma.companionMemory.findUnique({ where: { id: `${P}new-memory` } });
    expect(stale?.status).toBe("deleted");
    expect(fresh).toMatchObject({
      userId,
      characterId: CHAR,
      text: "User likes fresh context.",
      status: "active",
    });
  });
});
