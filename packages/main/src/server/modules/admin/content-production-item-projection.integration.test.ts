import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { markProductionItemGenerated } from "@/server/modules/content-production-state";

describe("Content production item projection authority", () => {
  const suffix = randomUUID();
  const userId = `item-projection-user-${suffix}`;
  const runId = `item-projection-run-${suffix}`;
  const jobId = `item-projection-job-${suffix}`;
  const itemId = `item-projection-item-${suffix}`;
  const assetId = `item-projection-asset-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test`, status: "active" },
    });
    await prisma.mediaAsset.create({ data: { id: assetId, ownerId: userId, type: "image", url: `memory://${assetId}`, safetyStatus: "passed", metadata: {} } });
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
    await prisma.mediaAsset.deleteMany({ where: { id: assetId } });
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

  it("rolls generation projection back if another writer advances the Run authority", async () => {
    await prisma.contentProductionItem.update({ where: { id: itemId }, data: { status: "queued" } });
    const before = await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } });
    let unlock!: () => void;
    let rowLocked!: () => void;
    let projectionReachedCas!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const reachedCas = new Promise<void>((resolve) => { projectionReachedCas = resolve; });
    const concurrentWriter = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "content_production_batches" WHERE "id" = ${runId} FOR UPDATE`;
      rowLocked();
      await gate;
      await tx.contentProductionBatch.update({ where: { id: runId }, data: { version: { increment: 1 } } });
    });
    await locked;
    const projection = prisma.$transaction(async (tx) => {
      const original = tx.contentProductionBatch.updateMany.bind(tx.contentProductionBatch);
      const writer = vi.spyOn(tx.contentProductionBatch, "updateMany").mockImplementationOnce((args) => {
        projectionReachedCas();
        return original(args);
      });
      try { await markProductionItemGenerated(tx, { jobId, mediaAssetId: assetId }); }
      finally { writer.mockRestore(); }
    });
    const rejected = expect(projection).rejects.toMatchObject({ status: 409 });
    try { await reachedCas; }
    finally { unlock(); }
    await concurrentWriter;
    await rejected;
    expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ lifecycleState: before.lifecycleState, workflowStage: before.workflowStage, version: before.version + 1 });
    expect(await prisma.contentProductionItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ status: "queued", mediaAssetId: null });
  });

  it("completes daily generation without manual review and preserves pending retry verification", async () => {
    const before = await prisma.contentProductionBatch.update({ where: { id: runId }, data: { verificationState: "verifying" } });
    await prisma.$transaction((tx) => markProductionItemGenerated(tx, { jobId, mediaAssetId: assetId }));
    expect(await prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ lifecycleState: "closed", workflowStage: "generation", verificationState: "verifying", status: "completed", version: before.version + 1, completedItems: 1, failedItems: 0, approvedItems: 0 });
    expect(await prisma.creativeReviewDecision.count({ where: { runItemId: itemId } })).toBe(0);
  });
});
