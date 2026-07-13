import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as createCreativeRun } from "@/app/api/v2/admin/creative/runs/route";
import { prisma } from "@/server/lib/db";
import { createUser } from "@/server/test/helpers";

describe("Creative Run v2 brief and launch", () => {
  const suffix = randomUUID();
  const actorId = `creative-create-${suffix}`;
  const idempotencyKey = `creative-create-key-${suffix}`;
  let batchId: string | null = null;
  let body: Record<string, unknown>;

  function request(payload = body) {
    return new Request("http://localhost/api/v2/admin/creative/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    await createUser({ id: actorId, role: "admin" });
    const profile = await prisma.generationModelProfile.findFirstOrThrow({
      where: { mode: "image", status: "active", enabled: true },
      orderBy: { version: "desc" },
    });
    body = {
      title: "Explicit operator brief",
      purpose: "feed",
      targetType: "none",
      profileId: profile.profileKey,
      presetIds: [],
      count: 2,
      brief: "Two editorial feed candidates with a coherent visual direction.",
      consistencyMode: "balanced",
      priority: "high",
      reason: "Launch a traceable Creative Run from the approved brief",
    };
  });

  afterAll(async () => {
    if (batchId) {
      const items = await prisma.contentProductionItem.findMany({
        where: { batchId },
        select: { jobId: true },
      });
      const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: batchId } });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attempt: { requestId: { in: jobIds } } },
      });
      await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
      await prisma.contentProductionBatch.deleteMany({ where: { id: batchId } });
      await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    }
    await prisma.controlPlaneCommand.deleteMany({
      where: { actorId, commandType: "creative.run.create" },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("atomically creates lineage and replays the same idempotent brief", async () => {
    const first = await createCreativeRun(request());
    expect(first.status).toBe(202);
    const firstPayload = await first.json();
    batchId = firstPayload.data.batch.id as string;
    expect(firstPayload.data).toMatchObject({ replayed: false, batch: { id: batchId } });
    expect(await prisma.contentProductionItem.count({ where: { batchId } })).toBe(2);
    const items = await prisma.contentProductionItem.findMany({ where: { batchId } });
    const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
    expect(await prisma.generationAttempt.count({ where: { requestId: { in: jobIds } } })).toBe(2);
    expect(await prisma.mainOutboxEvent.count({
      where: { aggregateId: batchId, eventType: "creative.generation.dispatch.v2" },
    })).toBe(2);

    const replay = await createCreativeRun(request());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { replayed: true, batch: { id: batchId } },
    });
    expect(await prisma.contentProductionBatch.count({ where: { id: batchId } })).toBe(1);
    expect(await prisma.contentProductionItem.count({ where: { batchId } })).toBe(2);
  });

  it("rejects reuse of the idempotency key for a different brief", async () => {
    const response = await createCreativeRun(request({ ...body, count: 3 }));
    expect(response.status).toBe(409);
  });

  it("persists selected directions as immutable item lineage inside one Run", async () => {
    const directionKey = `${idempotencyKey}-directions`;
    const directedRequest = new Request("http://localhost/api/v2/admin/creative/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": directionKey,
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        ...body,
        count: 1,
        directions: [
          {
            id: "direction-intimate",
            title: "Intimate close-up",
            scenePrompt: "A quiet close portrait with an emotionally readable gesture.",
            mood: "warm",
            setting: "window seat",
            outfit: "soft knitwear",
            camera: "85mm close portrait",
            lighting: "soft directional light",
          },
          {
            id: "direction-story",
            title: "Environmental story",
            scenePrompt: "A wider environmental portrait that reveals the story context.",
            mood: "reflective",
            setting: "late-night studio",
            outfit: "tailored casualwear",
            camera: "35mm environmental portrait",
            lighting: "practical lights and a gentle key",
          },
        ],
        outputsPerDirection: 2,
      }),
    });

    const response = await createCreativeRun(directedRequest);
    expect(response.status).toBe(202);
    const payload = await response.json();
    const directedBatchId = payload.data.batch.id as string;
    const items = await prisma.contentProductionItem.findMany({
      where: { batchId: directedBatchId },
      orderBy: { itemIndex: "asc" },
      select: { directionId: true, directionSnapshot: true, directionHash: true, jobId: true },
    });
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.directionId)).toEqual([
      "direction-intimate",
      "direction-intimate",
      "direction-story",
      "direction-story",
    ]);
    expect(items.every((item) => typeof item.directionHash === "string" && item.directionHash.length > 20)).toBe(true);
    expect(items[0]?.directionSnapshot).toMatchObject({ title: "Intimate close-up" });

    const jobIds = items.flatMap((item) => item.jobId ? [item.jobId] : []);
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: directedBatchId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attempt: { requestId: { in: jobIds } } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.contentProductionBatch.delete({ where: { id: directedBatchId } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { scope: { contains: "creative.run.create" }, idempotencyKey: directionKey } });
  });
});
