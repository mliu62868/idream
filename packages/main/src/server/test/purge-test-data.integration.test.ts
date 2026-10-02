import { randomUUID } from "node:crypto";
import { idempotencyKeys, MAIN_QUEUES } from "@idream/shared/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import {
  createUser,
  purgeQueuedGenerationJobs,
  purgeTestData,
} from "@/server/test/helpers";

const prefix = "zt-purge-queue-";
const foreignPrefix = "zt-purge-generation-foreign-";

beforeAll(async () => {
  await purgeTestData(prefix);
});

afterAll(async () => {
  await purgeTestData(prefix);
  await purgeTestData(foreignPrefix);
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
    const attempt = await prisma.generationAttempt.create({
      data: {
        requestId: generationJob.id,
        attemptNo: 1,
        provider: "mock",
        status: "running",
      },
    });
    const workKey = `generation:${generationJob.id}`;
    const finalizeKey = `generation-finalize:${generationJob.id}:completed`;
    const relayKey = idempotencyKeys.generationTerminalRelay(attempt.id);

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
    await jobQueue.enqueue({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: { terminalRecord: { attemptId: attempt.id } },
      dedupeKey: relayKey,
    });

    expect(await jobQueue.getByDedupeKey("ai.image.generate", workKey)).not.toBeNull();
    expect(await jobQueue.getByDedupeKey("app.ai.finalize", finalizeKey)).not.toBeNull();
    expect(await jobQueue.getByDedupeKey(
      MAIN_QUEUES.generationTerminalIngest,
      relayKey,
    )).not.toBeNull();

    await purgeTestData(prefix);

    expect(
      await prisma.generationJob.findUnique({ where: { id: generationJob.id } }),
    ).toBeNull();
    expect(await prisma.generationAttempt.findUnique({ where: { id: attempt.id } })).toBeNull();
    expect(await jobQueue.getByDedupeKey("ai.image.generate", workKey)).toBeNull();
    expect(await jobQueue.getByDedupeKey("app.ai.finalize", finalizeKey)).toBeNull();
    expect(await jobQueue.getByDedupeKey(
      MAIN_QUEUES.generationTerminalIngest,
      relayKey,
    )).toBeNull();
  });

  it("removes exact owned generation evidence while preserving another Request", async () => {
    async function fixture(userPrefix: string) {
      const userId = `${userPrefix}${randomUUID()}`;
      await createUser({ id: userId });
      return prisma.$transaction(async (tx) => {
        const request = await tx.generationJob.create({ data: {
          userId, mode: "image", controls: {}, presetIds: [], status: "completed", deliveredOutputCount: 1,
        } });
        const attempt = await tx.generationAttempt.create({ data: { requestId: request.id, attemptNo: 1 } });
        const terminal = await recordGenerationAttemptEvent(tx, {
          eventId: `${attempt.id}:succeeded`, attemptId: attempt.id, eventType: "generation.attempt.succeeded.v1",
          outcome: "succeeded", occurredAt: new Date(), payload: { requestId: request.id },
        });
        const transport = await tx.generationTransportExecution.create({ data: {
          attemptId: attempt.id, transportAttemptNo: 1, status: "succeeded", startedAt: terminal.occurredAt, finishedAt: terminal.occurredAt,
        } });
        const asset = await tx.mediaAsset.create({ data: { ownerId: userId, sourceJobId: request.id, type: "image", url: "/test.png", metadata: {} } });
        const artifact = await tx.generationArtifact.create({ data: {
          attemptId: attempt.id, ordinal: 0, assetId: asset.id, terminalRecordChecksum: "a".repeat(64), validationState: "valid",
        } });
        const delivery = await tx.generationDelivery.create({ data: {
          requestId: request.id, artifactId: artifact.id, targetType: "user_library", targetId: userId, status: "delivered", deliveredAt: terminal.occurredAt,
        } });
        const ledger = await tx.dreamcoinLedger.create({ data: { userId, delta: -1, balanceAfter: 0, reason: "generation_spend", sourceId: request.id, idempotencyKey: request.id } });
        const settlement = await tx.generationSettlementLink.create({ data: { requestId: request.id, ledgerEntryId: ledger.id, kind: "capture" } });
        const fulfillment = await tx.generationFulfillmentFact.create({ data: {
          requestId: request.id, sourceService: "test", sourceEventId: request.id, artifactId: artifact.id, userId,
          environment: "test", dataClass: "fixture", trustClass: "canonical", eligible: false, occurredAt: terminal.occurredAt, validFrom: terminal.occurredAt,
        } });
        const outbox = await tx.mainOutboxEvent.create({ data: {
          eventType: "generation.request.dispatch.v1", aggregateType: "generation_request", aggregateId: request.id, payload: {},
        } });
        return { request, attempt, terminal, transport, artifact, delivery, settlement, fulfillment, outbox };
      });
    }
    const owned = await fixture(prefix);
    const foreign = await fixture(foreignPrefix);
    await purgeTestData(prefix);

    expect(await prisma.generationAttempt.findUnique({ where: { id: owned.attempt.id } })).toBeNull();
    expect(await prisma.generationAttemptEvent.findUnique({ where: { id: owned.terminal.id } })).toBeNull();
    expect(await prisma.generationTransportExecution.findUnique({ where: { id: owned.transport.id } })).toBeNull();
    expect(await prisma.generationArtifact.findUnique({ where: { id: owned.artifact.id } })).toBeNull();
    expect(await prisma.generationDelivery.findUnique({ where: { id: owned.delivery.id } })).toBeNull();
    expect(await prisma.generationSettlementLink.findUnique({ where: { id: owned.settlement.id } })).toBeNull();
    expect(await prisma.generationFulfillmentFact.findUnique({ where: { id: owned.fulfillment.id } })).toBeNull();
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: owned.outbox.id } })).toBeNull();

    expect(await prisma.generationJob.findUnique({ where: { id: foreign.request.id } })).toEqual(foreign.request);
    expect(await prisma.generationAttempt.findUnique({ where: { id: foreign.attempt.id } })).toMatchObject({ requestId: foreign.request.id, status: "succeeded" });
    expect(await prisma.generationAttemptEvent.findUnique({ where: { id: foreign.terminal.id } })).toMatchObject({ payloadHash: foreign.terminal.payloadHash });
    expect(await prisma.generationTransportExecution.findUnique({ where: { id: foreign.transport.id } })).toEqual(foreign.transport);
    expect(await prisma.generationArtifact.findUnique({ where: { id: foreign.artifact.id } })).toEqual(foreign.artifact);
    expect(await prisma.generationDelivery.findUnique({ where: { id: foreign.delivery.id } })).toEqual(foreign.delivery);
    expect(await prisma.generationSettlementLink.findUnique({ where: { id: foreign.settlement.id } })).toEqual(foreign.settlement);
    expect(await prisma.generationFulfillmentFact.findUnique({ where: { id: foreign.fulfillment.id } })).toEqual(foreign.fulfillment);
    expect(await prisma.mainOutboxEvent.findUnique({ where: { id: foreign.outbox.id } })).toEqual(foreign.outbox);
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
