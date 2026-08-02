import { afterAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { reserveInitialGenerationAttempt } from "@/server/modules/generation/generation-attempt-authority";
import { retryGenerationRequest } from "./generation-request-lifecycle";
import { drainLocalAiPipeline } from "./local-pipeline";

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describe("Generation finalize Attempt authority", () => {
  it("ACKs an old terminal replay after retry without projecting it onto the latest Attempt", async () => {
    const suffix = crypto.randomUUID();
    const userId = `finalize-authority-user-${suffix}`;
    const requestId = `finalize-authority-request-${suffix}`;
    const firstDispatchId = `finalize-authority-dispatch-1-${suffix}`;
    const finalizeDedupeKey = `finalize-authority-old-${suffix}`;
    let firstAttemptId: string | null = null;
    let secondAttemptId: string | null = null;
    let firstQueueFact: { queue: "ai.image.generate"; dedupeKey: string; payload: unknown } | null = null;
    let secondQueueFact: { queue: "ai.image.generate"; dedupeKey: string; payload: unknown } | null = null;
    try {
      await prisma.user.create({
        data: { id: userId, email: `${userId}@idream.internal`, status: "active" },
      });
      await prisma.generationJob.create({
        data: {
          id: requestId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          outputCount: 1,
          status: "queued",
          provider: "mock",
          model: "mock-image-v2",
        },
      });
      const first = await prisma.$transaction((tx) =>
        reserveInitialGenerationAttempt(tx, {
          requestId,
          dispatch: {
            outboxId: firstDispatchId,
            eventType: "generation.retry.dispatch.v2",
          },
        })
      );
      firstAttemptId = first.attempt.id;
      const firstQueueInput = jsonRecord(jsonRecord(first.outbox.payload).queueInput);
      if (
        firstQueueInput.queue !== "ai.image.generate" ||
        typeof firstQueueInput.dedupeKey !== "string"
      ) {
        throw new Error("First Attempt dispatch queue authority is missing");
      }
      firstQueueFact = {
        queue: firstQueueInput.queue,
        dedupeKey: firstQueueInput.dedupeKey,
        payload: firstQueueInput.payload,
      };
      const terminalPayload = {
        version: 1,
        kind: "generation.failed",
        requestId: `generation_dispatch_${firstAttemptId}`,
        generationJobId: requestId,
        attemptId: firstAttemptId,
        attemptNo: 1,
        terminalRecordRef: `gen/terminal-records/${firstAttemptId}/terminal.json`,
        terminalRecordChecksum: "a".repeat(64),
        mode: "image",
        error: {
          code: "provider_failed",
          message: "Provider failed before the business retry",
          retryable: true,
          attemptOutcome: "failed",
          retryability: "retryable",
        },
      };
      await prisma.$transaction(async (tx) => {
        await tx.generationAttempt.update({
          where: { id: firstAttemptId! },
          data: {
            status: "failed",
            terminalRecordRef: terminalPayload.terminalRecordRef,
            finishedAt: new Date(),
          },
        });
        await tx.generationJob.update({
          where: { id: requestId },
          data: { status: "failed", errorCode: "provider_failed", finishedAt: new Date() },
        });
        await tx.mainOutboxEvent.create({
          data: {
            id: `generation_terminal_record_${firstAttemptId}`,
            eventType: "generation.terminal_record.accepted.v1",
            aggregateType: "generation_attempt",
            aggregateId: firstAttemptId!,
            payload: terminalPayload,
            status: "delivered",
            deliveredAt: new Date(),
          },
        });
      });
      const retried = await retryGenerationRequest({
        requestId,
        expectedVersion: 1,
        actor: { id: userId, role: "user" },
        reason: "Create the authoritative second Attempt",
        idempotencyKey: `finalize-authority-retry-${suffix}`,
        traceId: `finalize-authority-trace-${suffix}`,
      });
      if (
        typeof retried !== "object" ||
        retried === null ||
        Array.isArray(retried) ||
        typeof retried.attemptId !== "string"
      ) {
        throw new Error("Retry did not return the second Attempt identity");
      }
      secondAttemptId = retried.attemptId;
      const secondDispatch = await prisma.mainOutboxEvent.findFirstOrThrow({
        where: {
          aggregateId: requestId,
          eventType: "generation.retry.dispatch.v2",
          payload: { path: ["attemptId"], equals: secondAttemptId },
        },
      });
      const secondQueueInput = jsonRecord(jsonRecord(secondDispatch.payload).queueInput);
      if (
        secondQueueInput.queue !== "ai.image.generate" ||
        typeof secondQueueInput.dedupeKey !== "string"
      ) {
        throw new Error("Second Attempt dispatch queue authority is missing");
      }
      secondQueueFact = {
        queue: secondQueueInput.queue,
        dedupeKey: secondQueueInput.dedupeKey,
        payload: secondQueueInput.payload,
      };
      await jobQueue.enqueue({
        queue: firstQueueFact.queue,
        dedupeKey: firstQueueFact.dedupeKey,
        payload: firstQueueFact.payload as Prisma.InputJsonValue,
      });
      await jobQueue.enqueue({
        queue: secondQueueFact.queue,
        dedupeKey: secondQueueFact.dedupeKey,
        payload: secondQueueFact.payload as Prisma.InputJsonValue,
      });
      await jobQueue.enqueue({
        queue: "app.ai.finalize",
        dedupeKey: finalizeDedupeKey,
        payload: terminalPayload,
      });

      await expect(drainLocalAiPipeline({
        limit: 1,
        queues: ["app.ai.finalize"],
      })).resolves.toMatchObject({ processed: 1 });
      await expect(prisma.generationJob.findUniqueOrThrow({
        where: { id: requestId },
      })).resolves.toMatchObject({ status: "queued", version: 2, errorCode: null });
      await expect(prisma.generationAttempt.findUniqueOrThrow({
        where: { id: secondAttemptId },
      })).resolves.toMatchObject({ status: "queued", attemptNo: 2 });
      await expect(prisma.mediaAsset.count({ where: { sourceJobId: requestId } }))
        .resolves.toBe(0);
      await expect(prisma.generationDelivery.count({ where: { requestId } }))
        .resolves.toBe(0);
      await expect(jobQueue.getByDedupeKey(
        firstQueueFact.queue,
        firstQueueFact.dedupeKey,
      )).resolves.toBeNull();
      await expect(jobQueue.getByDedupeKey(
        secondQueueFact.queue,
        secondQueueFact.dedupeKey,
      )).resolves.toMatchObject({ dedupeKey: secondQueueFact.dedupeKey });
    } finally {
      if (firstQueueFact) {
        await jobQueue.removeByDedupeKey(firstQueueFact.queue, firstQueueFact.dedupeKey);
      }
      if (secondQueueFact) {
        await jobQueue.removeByDedupeKey(secondQueueFact.queue, secondQueueFact.dedupeKey);
      }
      await jobQueue.removeByDedupeKey("app.ai.finalize", finalizeDedupeKey);
      const commands = await prisma.controlPlaneCommand.findMany({
        where: { targetId: requestId },
        select: { id: true },
      });
      await prisma.controlPlaneCommandAttempt.deleteMany({
        where: { commandId: { in: commands.map((command) => command.id) } },
      });
      await prisma.adminAuditLog.deleteMany({ where: { targetId: requestId } });
      await prisma.controlPlaneCommand.deleteMany({ where: { targetId: requestId } });
      await prisma.mainOutboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateId: requestId },
            ...(firstAttemptId ? [{ aggregateId: firstAttemptId }] : []),
            ...(secondAttemptId ? [{ aggregateId: secondAttemptId }] : []),
          ],
        },
      });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attemptId: { in: [firstAttemptId ?? "", secondAttemptId ?? ""] } },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: { in: [firstAttemptId ?? "", secondAttemptId ?? ""] } },
      });
      await prisma.generationJob.deleteMany({ where: { id: requestId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
