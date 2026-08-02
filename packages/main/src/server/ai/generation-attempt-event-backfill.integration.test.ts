import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { backfillGenerationAttemptEvents } from "./generation-attempt-event-backfill";

describe("GenerationAttemptEvent backfill", () => {
  const suffix = randomUUID();
  const prefix = `zz-attempt-event-backfill-${suffix}`;
  const cursor = `${prefix}-`;
  const userId = `${prefix}-user`;
  const attemptIds = [1, 2, 3, 4].map((index) => `${prefix}-${index}-attempt`);
  const jobIds = [1, 2, 3, 4].map((index) => `${prefix}-${index}-job`);

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    for (const jobId of jobIds) {
      await prisma.generationJob.create({
        data: { id: jobId, userId, mode: "image", controls: {}, presetIds: [] },
      });
    }
    await prisma.generationAttempt.createMany({
      data: [
        {
          id: attemptIds[0], requestId: jobIds[0], attemptNo: 1, status: "succeeded",
          terminalRecordRef: `gen/terminal-records/${attemptIds[0]}/terminal.json`, finishedAt: new Date("2026-07-11T10:00:00Z"),
        },
        {
          id: attemptIds[1], requestId: jobIds[1], attemptNo: 1, status: "failed",
          errorCode: "provider_timeout", retryability: "retryable", finishedAt: new Date("2026-07-11T10:01:00Z"),
        },
        {
          id: attemptIds[2], requestId: jobIds[2], attemptNo: 1, status: "succeeded",
          finishedAt: new Date("2026-07-11T10:02:00Z"),
        },
        {
          id: attemptIds[3], requestId: jobIds[3], attemptNo: 1, status: "failed",
          errorCode: "delivery_failed", finishedAt: new Date("2026-07-11T10:03:00Z"),
        },
      ],
    });
    await prisma.generationArtifact.create({
      data: {
        id: `${prefix}-artifact`,
        attemptId: attemptIds[3],
        ordinal: 0,
        terminalRecordChecksum: "0".repeat(64),
        validationState: "valid",
      },
    });
    await prisma.generationDelivery.create({
      data: {
        id: `${prefix}-delivery`,
        requestId: jobIds[3],
        artifactId: `${prefix}-artifact`,
        targetType: "user_library",
        targetId: userId,
        status: "delivered",
        deliveredAt: new Date("2026-07-11T10:03:00Z"),
      },
    });
  });

  afterAll(async () => {
    await prisma.generationDelivery.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId: { in: attemptIds } } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: attemptIds } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("dry-runs evidence classification without fabricating ambiguous terminal facts", async () => {
    const report = await backfillGenerationAttemptEvents(prisma, {
      mode: "dry-run",
      cursor,
      batchSize: 4,
    });
    expect(report).toMatchObject({ examined: 4, ready: 2, applied: 0, partial: 1, mismatch: 1 });
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId: attemptIds[2], classification: "partial", reason: "success_without_terminal_record_or_artifact" }),
      expect.objectContaining({ attemptId: attemptIds[3], classification: "mismatch", reason: "failed_attempt_has_delivered_artifact" }),
    ]));
    expect(await prisma.generationAttemptEvent.count({ where: { attemptId: { in: attemptIds } } })).toBe(0);
  });

  it("applies only reliable facts and is idempotent on resume", async () => {
    const applied = await backfillGenerationAttemptEvents(prisma, {
      mode: "apply",
      cursor,
      batchSize: 4,
    });
    expect(applied).toMatchObject({ ready: 2, applied: 2, partial: 1, mismatch: 1 });
    expect(await prisma.generationAttemptEvent.findMany({
      where: { attemptId: { in: attemptIds } },
      orderBy: { attemptId: "asc" },
    })).toEqual([
      expect.objectContaining({ attemptId: attemptIds[0], outcome: "succeeded", sequence: 1 }),
      expect.objectContaining({ attemptId: attemptIds[1], outcome: "failed", sequence: 1 }),
    ]);

    const resumed = await backfillGenerationAttemptEvents(prisma, {
      mode: "apply",
      cursor,
      batchSize: 4,
    });
    expect(resumed).toMatchObject({ canonical: 2, ready: 0, applied: 0, partial: 1, mismatch: 1 });
    expect(await prisma.generationAttemptEvent.count({ where: { attemptId: { in: attemptIds } } })).toBe(2);
  });
});
