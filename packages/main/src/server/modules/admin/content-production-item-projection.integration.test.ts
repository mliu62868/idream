import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { markProductionItemGenerated } from "@/server/modules/content-production-state";

describe("Content production item projection authority", () => {
  const suffix = randomUUID();
  const userId = `item-projection-user-${suffix}`;
  const runId = `item-projection-run-${suffix}`;
  const jobId = `item-projection-job-${suffix}`;
  const itemId = `item-projection-item-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test`, status: "active" },
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Projection authority fixture",
        purpose: "feed",
        targetType: "none",
        presetIds: [],
        count: 1,
        totalItems: 1,
        failedItems: 1,
        status: "completed",
        lifecycleState: "active",
        workflowStage: "generation",
        createdById: userId,
        items: {
          create: {
            id: itemId,
            itemIndex: 0,
            jobId,
            status: "failed",
            tags: [],
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.contentProductionBatch.deleteMany({ where: { id: runId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("rejects failed to generated without changing item or Run facts", async () => {
    const before = await Promise.all([
      prisma.contentProductionItem.findUniqueOrThrow({ where: { id: itemId } }),
      prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } }),
    ]);

    await expect(
      prisma.$transaction((tx) =>
        markProductionItemGenerated(tx, {
          jobId,
          mediaAssetId: `item-projection-asset-${suffix}`,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });

    const after = await Promise.all([
      prisma.contentProductionItem.findUniqueOrThrow({ where: { id: itemId } }),
      prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } }),
    ]);
    expect(after).toEqual(before);
  });
});
