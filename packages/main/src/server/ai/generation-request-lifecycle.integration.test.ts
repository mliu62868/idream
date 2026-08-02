import { randomUUID } from "node:crypto";
import { generationTerminalRecordChecksum } from "@idream/shared/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnqueueJobInput } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import {
  dispatchGenerationAttemptOutbox,
  reserveInitialGenerationAttempt,
} from "@/server/modules/generation/generation-attempt-authority";
import { ingestGenerationTerminalRecord } from "./generation-terminal-record-ingest";
import { cancelGenerationRequest } from "./generation-request-lifecycle";

describe("Generation Request cancellation", () => {
  const suffix = randomUUID();
  const actorId = `cancel-actor-${suffix}`;
  const userId = `cancel-user-${suffix}`;
  const jobId = `cancel-job-${suffix}`;
  const attemptId = `cancel-attempt-${suffix}`;
  const idempotencyKey = `cancel-command-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `${actorId}@idream.internal`, role: "admin", status: "active" },
      { id: userId, email: `${userId}@idream.internal`, role: "user", status: "active" },
    ] });
    await prisma.generationJob.create({ data: { id: jobId, userId, mode: "image", controls: {}, presetIds: [], outputCount: 1, costDreamcoins: 10, status: "queued", provider: "mock" } });
    await prisma.dreamcoinLedger.create({ data: { userId, delta: -10, balanceAfter: 90, reason: "generation_spend", sourceId: jobId, idempotencyKey: `cancel-spend-${suffix}` } });
    await prisma.$transaction(async (tx) => {
      await tx.generationAttempt.create({ data: { id: attemptId, requestId: jobId, attemptNo: 1, provider: "mock", status: "queued" } });
      await reserveInitialGenerationAttempt(tx, {
        requestId: jobId,
        dispatch: {
          outboxId: `generation_initial_${jobId}`,
          eventType: "generation.retry.dispatch.v2",
        },
      });
      await tx.generationJob.update({ where: { id: jobId }, data: { status: "running" } });
      await tx.generationAttempt.update({ where: { id: attemptId }, data: { status: "running", startedAt: new Date() } });
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: jobId } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: (await prisma.controlPlaneCommand.findMany({ where: { actorId }, select: { id: true } })).map((row) => row.id) } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.inboundEventReceipt.deleteMany({ where: { sourceService: "gen", sourceEventId: attemptId } });
    await prisma.generationJobEvent.deleteMany({ where: { jobId } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: jobId } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId } });
    await prisma.generationTransportExecution.deleteMany({ where: { attemptId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId } });
    await prisma.generationAttempt.deleteMany({ where: { id: attemptId } });
    await prisma.generationSettlementLink.deleteMany({ where: { requestId: jobId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: jobId } });
    await prisma.generationJob.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, userId] } } });
    await prisma.$disconnect();
  });

  it("replays the same cancellation, rejects key collisions, refunds once, and suppresses a late terminal record", async () => {
    const input = { requestId: jobId, expectedVersion: 1, actor: { id: actorId, role: "admin" }, reason: "User requested cancellation", idempotencyKey, traceId: `cancel-trace-${suffix}` };
    const cancelled = await cancelGenerationRequest(input);
    await expect(cancelGenerationRequest(input)).resolves.toEqual(cancelled);
    await expect(cancelGenerationRequest({
      ...input,
      reason: "A different cancellation payload",
    })).rejects.toMatchObject({ status: 409 });
    expect(cancelled).toMatchObject({ requestId: jobId, status: "cancelled", version: 2, refundAmount: 10 });
    await expect(prisma.generationAttempt.findUnique({ where: { id: attemptId } })).resolves.toMatchObject({ status: "cancelled", retryability: "not_retryable" });
    await expect(prisma.generationSettlementLink.count({ where: { requestId: jobId } })).resolves.toBe(2);

    const dispatch = await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: `generation_initial_${jobId}` },
    });
    expect(dispatch).toMatchObject({
      status: "cancelled",
      deliveredAt: null,
      lastError: expect.objectContaining({
        code: "generation_dispatch_cancelled",
        attemptId,
      }),
    });
    const enqueued: EnqueueJobInput[] = [];
    await expect(dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [dispatch.id],
      queue: {
        enqueue: async (queueJob) => {
          enqueued.push(queueJob);
        },
        removeByDedupeKey: async () => false,
      },
    })).resolves.toMatchObject({ examined: 0, delivered: 0, failed: 0 });
    expect(enqueued).toEqual([]);
    const dispatchPayload = dispatch.payload as Record<string, unknown>;
    const queueInput = dispatchPayload.queueInput as Record<string, unknown>;
    const queuePayload = queueInput.payload as Record<string, unknown>;
    const terminalRecord = { version: 1 as const, outcome: "succeeded" as const, attemptId, attemptNo: 1, transportAttemptNo: 1, providerIdempotencyKey: `generation:${attemptId}:provider`, requestId: queuePayload.requestId as string, generationJobId: jobId, mode: "image" as const, provider: queuePayload.provider as string, providerInvoked: true, model: queuePayload.model as string, providerRequestId: null, completedAt: new Date().toISOString(), assets: [{ ordinal: 0, key: `${queuePayload.outputPrefix as string}image.webp`, contentType: "image/webp", width: 1024, height: 1024, providerKey: "late-provider-asset" }], usage: { gpuSeconds: 1 } };
    await expect(ingestGenerationTerminalRecord({ terminalRecordRef: `gen/terminal-records/${attemptId}/terminal.json`, terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord), terminalRecord })).resolves.toMatchObject({ acknowledged: true, status: "persisted" });
    await expect(prisma.generationArtifact.findFirst({ where: { attemptId } })).resolves.toMatchObject({ archiveState: "archived", validationState: "late_after_cancelled", assetId: null });
    await expect(prisma.generationDelivery.findFirst({ where: { requestId: jobId } })).resolves.toMatchObject({
      status: "suppressed",
      deliveredAt: null,
    });
    await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({ status: "cancelled", deliveredOutputCount: 0, completedAt: null, finishedAt: expect.any(Date) });
  });

  it("removes a job enqueued in the cancellation race window and keeps refund authority atomic", async () => {
    const raceJobId = `cancel-race-job-${suffix}`;
    const raceAttemptId = `cancel-race-attempt-${suffix}`;
    const raceOutboxId = `generation_initial_${raceJobId}`;
    await prisma.generationJob.create({
      data: {
        id: raceJobId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        costDreamcoins: 7,
        status: "queued",
        provider: "mock",
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        userId,
        delta: -7,
        balanceAfter: 83,
        reason: "generation_spend",
        sourceId: raceJobId,
        idempotencyKey: `cancel-race-spend-${suffix}`,
      },
    });
    await prisma.$transaction(async (tx) => {
      await tx.generationAttempt.create({
        data: {
          id: raceAttemptId,
          requestId: raceJobId,
          attemptNo: 1,
          provider: "mock",
          status: "queued",
        },
      });
      await reserveInitialGenerationAttempt(tx, {
        requestId: raceJobId,
        dispatch: {
          outboxId: raceOutboxId,
          eventType: "generation.retry.dispatch.v2",
        },
      });
    });

    const enqueued: EnqueueJobInput[] = [];
    const removed: Array<{ queue: string; dedupeKey: string }> = [];
    try {
      const dispatched = await dispatchGenerationAttemptOutbox(prisma, {
        outboxIds: [raceOutboxId],
        queue: {
          enqueue: async (queueJob) => {
            enqueued.push(queueJob);
            await cancelGenerationRequest({
              requestId: raceJobId,
              expectedVersion: 1,
              actor: { id: actorId, role: "admin" },
              reason: "Cancellation won the enqueue race",
              idempotencyKey: `cancel-race-command-${suffix}`,
              traceId: `cancel-race-trace-${suffix}`,
            });
          },
          removeByDedupeKey: async (queue, dedupeKey) => {
            removed.push({ queue, dedupeKey });
            return true;
          },
        },
      });

      expect(dispatched).toMatchObject({ examined: 1, delivered: 0, failed: 0 });
      expect(enqueued).toHaveLength(1);
      expect(removed).toEqual([{
        queue: "ai.image.generate",
        dedupeKey: `generation:${raceJobId}:attempt:1`,
      }]);
      await expect(prisma.generationJob.findUniqueOrThrow({
        where: { id: raceJobId },
      })).resolves.toMatchObject({ status: "cancelled", version: 2 });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: raceAttemptId },
      })).resolves.toMatchObject({
        status: "cancelled",
        retryability: "not_retryable",
      });
      await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
        where: { id: raceOutboxId },
      })).resolves.toMatchObject({
        status: "cancelled",
        deliveredAt: null,
        lastError: expect.objectContaining({
          code: "generation_dispatch_cancelled",
          attemptId: raceAttemptId,
        }),
      });
      await expect(prisma.dreamcoinLedger.count({
        where: {
          sourceId: raceJobId,
          reason: "refund",
          delta: 7,
        },
      })).resolves.toBe(1);
    } finally {
      const commands = await prisma.controlPlaneCommand.findMany({
        where: { targetId: raceJobId },
        select: { id: true },
      });
      await prisma.controlPlaneCommandAttempt.deleteMany({
        where: { commandId: { in: commands.map((command) => command.id) } },
      });
      await prisma.controlPlaneCommand.deleteMany({ where: { targetId: raceJobId } });
      await prisma.adminAuditLog.deleteMany({ where: { targetId: raceJobId } });
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: raceJobId } });
      await prisma.generationJobEvent.deleteMany({ where: { jobId: raceJobId } });
      await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: raceAttemptId } });
      await prisma.generationAttempt.deleteMany({ where: { id: raceAttemptId } });
      await prisma.generationSettlementLink.deleteMany({ where: { requestId: raceJobId } });
      await prisma.dreamcoinLedger.deleteMany({ where: { sourceId: raceJobId } });
      await prisma.generationJob.deleteMany({ where: { id: raceJobId } });
    }
  });
});
