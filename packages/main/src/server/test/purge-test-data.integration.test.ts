import { randomUUID } from "node:crypto";
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
  it("removes canonical product-event evidence owned by a random-id fixture user", async () => {
    const userId = randomUUID();
    const sourceEventId = `signup:${userId}`;
    const user = await prisma.user.create({
      data: {
        id: userId,
        email: `${prefix}${randomUUID()}@customer.invalid`,
      },
    });
    const event = await prisma.analyticsEvent.create({
      data: {
        userId: user.id,
        name: "customer.signup.completed.v2",
        props: { userId: user.id },
        sourceService: "main",
        sourceEventId,
        schemaVersion: 2,
        actor: { userId: user.id, isInternal: false },
      },
    });
    await prisma.metricProjectionReceipt.create({
      data: {
        sourceService: "main",
        sourceEventId,
        canonicalEventId: event.id,
        eventType: event.name,
        outcome: "applied",
        factType: "customer_signup",
        factId: user.id,
        occurredAt: new Date(),
      },
    });
    await prisma.inboundEventReceipt.create({
      data: {
        sourceService: "main.product_projection:main",
        sourceEventId,
        payloadHash: "a".repeat(64),
        processingState: "processed",
        processedAt: new Date(),
      },
    });
    const outbox = await prisma.mainOutboxEvent.create({
      data: {
        eventType: "product.event.persisted.v2",
        aggregateType: "product_event",
        aggregateId: event.id,
        payload: { eventId: event.id, sourceService: "main", sourceEventId },
      },
    });

    await purgeTestData(prefix);

    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.toBeNull();
    await expect(prisma.analyticsEvent.findUnique({ where: { id: event.id } })).resolves.toBeNull();
    await expect(prisma.mainOutboxEvent.findUnique({ where: { id: outbox.id } })).resolves.toBeNull();
    await expect(prisma.metricProjectionReceipt.findUnique({
      where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId } },
    })).resolves.toBeNull();
    await expect(prisma.inboundEventReceipt.findUnique({
      where: {
        sourceService_sourceEventId: {
          sourceService: "main.product_projection:main",
          sourceEventId,
        },
      },
    })).resolves.toBeNull();
  });

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
