import { randomUUID } from "node:crypto";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  projectCanonicalMetricEvent,
  requeueQuarantinedMetricEvent,
} from "@/server/modules/admin-v2/metrics/projector";
import { selectQualityChecksForMetric } from "@/server/modules/admin-v2/metrics/query";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { dispatchPendingProductEvents } from "./event-consumer";

describe("metric product-event recovery", () => {
  const prefix = `metric-outbox-${randomUUID()}`;
  const userId = `${prefix}-user`;

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, email: `${userId}@customer.invalid`, role: "user", status: "active" },
    });
  });

  afterAll(async () => {
    await prisma.generationFulfillmentFact.deleteMany({ where: { userId } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: { startsWith: prefix } } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId: { startsWith: prefix } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { startsWith: prefix } } });
    await prisma.generationJob.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.subscriptionLifecycleFact.deleteMany({ where: { userId } });
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
    await prisma.inboundEventReceipt.deleteMany({
      where: {
        sourceService: { startsWith: "main.product_projection:" },
        sourceEventId: { startsWith: prefix },
      },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.analyticsEvent.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
    await prisma.recentChat.deleteMany({ where: { sessionId: { startsWith: prefix } } });
    await prisma.character.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.dataQualityCheck.deleteMany({
      where: {
        checkKey: "metrics.server_outcome_completeness",
        evidence: { path: ["sourceEventId"], string_starts_with: prefix },
      },
    });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function persistEvent(input: {
    readonly sourceEventId: string;
    readonly eventType: string;
    readonly occurredAt: Date;
    readonly props: Record<string, unknown>;
    readonly context?: Record<string, unknown>;
    readonly sourceService?: string;
    readonly environment?: string;
    readonly dataClass?: string;
    readonly actorIsInternal?: boolean;
  }) {
    const sourceService = input.sourceService ?? "main";
    const event = await prisma.analyticsEvent.create({
      data: {
        id: `${input.sourceEventId}-${sourceService}-canonical`,
        name: input.eventType,
        props: toInputJson(input.props),
        sourceService,
        sourceEventId: input.sourceEventId,
        schemaVersion: 2,
        occurredAt: input.occurredAt,
        ingestedAt: new Date(input.occurredAt.getTime() + 1_000),
        environment: input.environment ?? "production",
        dataClass: input.dataClass ?? "customer",
        trustClass: "canonical",
        actor: { userId, isInternal: input.actorIsInternal ?? false },
        context: toInputJson(input.context ?? {}),
      },
    });
    const outbox = await prisma.mainOutboxEvent.create({
      data: {
        id: `${input.sourceEventId}-${sourceService}-outbox`,
        eventType: "product.event.persisted.v2",
        aggregateType: "product_event",
        aggregateId: event.id,
        status: "pending",
        nextRunAt: new Date("2000-01-01T00:00:00Z"),
        createdAt: new Date("2000-01-01T00:00:00Z"),
        payload: { eventId: event.id, sourceService, sourceEventId: input.sourceEventId },
      },
    });
    return { event, outbox };
  }

  function dispatchOutboxes(outboxIds: readonly string[]) {
    return dispatchPendingProductEvents(Math.max(1, outboxIds.length), { outboxIds });
  }

  function expectConcurrentDispatchSuccess(
    results: readonly { readonly delivered: number; readonly failed: number }[],
  ) {
    expect(results.some((result) => result.delivered === 1)).toBe(true);
    expect(results.every((result) => result.failed === 0)).toBe(true);
  }

  it("isolates a targeted dispatch from unrelated pending product events", async () => {
    const sourceEventId = `${prefix}-targeted-dispatch`;
    const { outbox } = await persistEvent({
      sourceEventId,
      eventType: "test.targeted_dispatch.v2",
      occurredAt: new Date("2026-07-16T12:45:39Z"),
      props: { userId },
    });
    const unrelatedOutboxId = `${prefix}-unrelated-missing-canonical-outbox`;
    await prisma.mainOutboxEvent.create({
      data: {
        id: unrelatedOutboxId,
        eventType: "product.event.persisted.v2",
        aggregateType: "product_event",
        aggregateId: `${prefix}-unrelated-missing-canonical`,
        status: "pending",
        nextRunAt: new Date("1900-01-01T00:00:00Z"),
        createdAt: new Date("1900-01-01T00:00:00Z"),
        payload: {
          eventId: `${prefix}-unrelated-missing-canonical`,
          sourceService: "chat",
          sourceEventId: `${prefix}-unrelated-missing-canonical-source`,
        },
      },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: unrelatedOutboxId },
    })).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
    });
    await prisma.mainOutboxEvent.delete({ where: { id: unrelatedOutboxId } });
  });

  it("redacts derived chat-image text even while a correction awaits its metric fact", async () => {
    const exchangeId = `${prefix}-privacy-deferred-exchange`;
    const sourceEventId = `${prefix}-privacy-deferred-correction`;
    const job = await prisma.generationJob.create({
      data: {
        id: `${prefix}-privacy-deferred-job`,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        sourceType: "chat_image",
        sourceId: `${prefix}-privacy-deferred-attachment`,
        sourceMeta: {
          sessionId: `${prefix}-privacy-deferred-session`,
          exchangeId,
          messageId: `${prefix}-privacy-deferred-assistant`,
          promptHint: "private prompt awaiting metric fact",
          conversationContext: "user: private context awaiting metric fact",
        },
      },
    });
    const { outbox } = await persistEvent({
      sourceEventId,
      eventType: CHAT_TO_MAIN_EVENTS.exchangeCorrectedV2,
      occurredAt: new Date("2026-07-18T22:00:00Z"),
      sourceService: "chat",
      context: { aggregateId: exchangeId },
      props: {
        exchangeId,
        correctionType: "deleted",
        correctionRevision: 1,
        userId,
        sessionId: `${prefix}-privacy-deferred-session`,
        messageIds: [
          exchangeId,
          `${prefix}-privacy-deferred-assistant`,
        ],
      },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({
      delivered: 0,
      failed: 1,
    });
    await expect(prisma.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    })).resolves.toMatchObject({
      sourceMeta: {
        sessionId: `${prefix}-privacy-deferred-session`,
        exchangeId,
        messageId: `${prefix}-privacy-deferred-assistant`,
        promptHint: null,
        conversationContext: null,
        privacyRedaction: {
          reason: "logical_exchange_deleted",
          sourceEventId,
          redactedAt: "2026-07-18T22:00:00.000Z",
        },
      },
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: outbox.id },
    })).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: {
        message: "Metric projection deferred: awaiting_required_fact",
      },
    });
  });

  it("terminally skips an internal chat projection whose domain authority is absent", async () => {
    const sourceEventId = `${prefix}-internal-chat-session`;
    const sessionId = `${prefix}-missing-session`;
    const { outbox } = await persistEvent({
      sourceEventId,
      eventType: "chat.session.created",
      occurredAt: new Date("2026-07-16T12:45:40Z"),
      sourceService: "chat",
      environment: "development",
      dataClass: "internal",
      actorIsInternal: true,
      context: { aggregateId: sessionId },
      props: {
        userId: `${prefix}-missing-user`,
        characterId: `${prefix}-missing-character`,
      },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    await prisma.mainOutboxEvent.update({
      where: { id: outbox.id },
      data: {
        status: "pending",
        deliveredAt: null,
        nextRunAt: new Date("2000-01-01T00:00:00Z"),
      },
    });
    const concurrentResults = await Promise.all([
      dispatchOutboxes([outbox.id]),
      dispatchOutboxes([outbox.id]),
    ]);
    expectConcurrentDispatchSuccess(concurrentResults);
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: outbox.id },
    })).resolves.toMatchObject({
      status: "delivered",
      attempts: 0,
      deliveredAt: expect.any(Date),
      lastError: {
        outcome: "skipped",
        reason: "chat_projection_customer_authority_missing",
      },
    });
    await expect(prisma.recentChat.findUnique({
      where: { sessionId },
    })).resolves.toBeNull();
  });

  it("isolates projection receipts by the canonical origin service", async () => {
    const sourceEventId = `${prefix}-shared-source-event`;
    const [firstCharacter, secondCharacter] = await Promise.all([
      prisma.character.create({
        data: {
          id: `${prefix}-source-character-a`,
          name: "Source namespace A",
          age: 24,
          description: "d",
          appearance: {},
          advancedDetails: {},
          stats: { create: { chatsCount: 0 } },
        },
      }),
      prisma.character.create({
        data: {
          id: `${prefix}-source-character-b`,
          name: "Source namespace B",
          age: 24,
          description: "d",
          appearance: {},
          advancedDetails: {},
          stats: { create: { chatsCount: 0 } },
        },
      }),
    ]);
    const sourceEvents = await Promise.all([
      persistEvent({
        sourceEventId,
        sourceService: "chat",
        eventType: "chat.message.completed",
        occurredAt: new Date("2026-07-16T12:45:41Z"),
        context: { aggregateId: `${prefix}-source-message-a` },
        props: {
          userId,
          characterId: firstCharacter.id,
        },
      }),
      persistEvent({
        sourceEventId,
        sourceService: "chat-replay-import",
        eventType: "chat.message.completed",
        occurredAt: new Date("2026-07-16T12:45:42Z"),
        context: { aggregateId: `${prefix}-source-message-b` },
        props: {
          userId,
          characterId: secondCharacter.id,
        },
      }),
    ]);

    await expect(dispatchOutboxes(sourceEvents.map(({ outbox }) => outbox.id))).resolves.toEqual({
      delivered: 2,
      failed: 0,
    });
    await expect(prisma.characterStats.findMany({
      where: { characterId: { in: [firstCharacter.id, secondCharacter.id] } },
      orderBy: { characterId: "asc" },
      select: { characterId: true, chatsCount: true },
    })).resolves.toEqual([
      { characterId: firstCharacter.id, chatsCount: 1 },
      { characterId: secondCharacter.id, chatsCount: 1 },
    ]);
    await expect(prisma.inboundEventReceipt.findMany({
      where: {
        sourceEventId,
        sourceService: {
          in: [
            "main.product_projection:chat",
            "main.product_projection:chat-replay-import",
          ],
        },
      },
      orderBy: { sourceService: "asc" },
      select: { sourceService: true, processingState: true },
    })).resolves.toEqual([
      {
        sourceService: "main.product_projection:chat",
        processingState: "processed",
      },
      {
        sourceService: "main.product_projection:chat-replay-import",
        processingState: "processed",
      },
    ]);
  });

  it("applies one domain effect across overlapping scans and a delivered-row replay", async () => {
    const sourceEventId = `${prefix}-overlapping-message`;
    const character = await prisma.character.create({
      data: {
        id: `${prefix}-overlapping-character`,
        name: "Overlapping dispatcher target",
        age: 24,
        description: "d",
        appearance: {},
        advancedDetails: {},
        stats: { create: { chatsCount: 0 } },
      },
    });
    const { outbox } = await persistEvent({
      sourceEventId,
      sourceService: "chat",
      eventType: "chat.message.completed",
      occurredAt: new Date("2026-07-16T12:45:43Z"),
      context: { aggregateId: `${prefix}-overlapping-message` },
      props: {
        userId,
        characterId: character.id,
      },
    });

    const concurrentResults = await Promise.all([
      dispatchOutboxes([outbox.id]),
      dispatchOutboxes([outbox.id]),
    ]);
    expectConcurrentDispatchSuccess(concurrentResults);
    await expect(prisma.characterStats.findUniqueOrThrow({
      where: { characterId: character.id },
    })).resolves.toMatchObject({ chatsCount: 1 });

    await prisma.mainOutboxEvent.update({
      where: { id: outbox.id },
      data: {
        status: "pending",
        deliveredAt: null,
        nextRunAt: new Date("2000-01-01T00:00:00Z"),
      },
    });
    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    await expect(prisma.characterStats.findUniqueOrThrow({
      where: { characterId: character.id },
    })).resolves.toMatchObject({ chatsCount: 1 });
    await expect(prisma.inboundEventReceipt.count({
      where: {
        sourceService: "main.product_projection:chat",
        sourceEventId,
      },
    })).resolves.toBe(1);
  });

  it("terminally quarantines an outbox replay whose canonical payload changed", async () => {
    const sourceEventId = `${prefix}-tampered-message`;
    const [firstCharacter, secondCharacter] = await Promise.all([
      prisma.character.create({
        data: {
          id: `${prefix}-tampered-character-a`,
          name: "Tampered payload A",
          age: 24,
          description: "d",
          appearance: {},
          advancedDetails: {},
          stats: { create: { chatsCount: 0 } },
        },
      }),
      prisma.character.create({
        data: {
          id: `${prefix}-tampered-character-b`,
          name: "Tampered payload B",
          age: 24,
          description: "d",
          appearance: {},
          advancedDetails: {},
          stats: { create: { chatsCount: 0 } },
        },
      }),
    ]);
    const { event, outbox } = await persistEvent({
      sourceEventId,
      sourceService: "chat",
      eventType: "chat.message.completed",
      occurredAt: new Date("2026-07-16T12:45:44Z"),
      context: { aggregateId: `${prefix}-tampered-message` },
      props: {
        userId,
        characterId: firstCharacter.id,
      },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    await prisma.analyticsEvent.update({
      where: { id: event.id },
      data: {
        props: toInputJson({
          userId,
          characterId: secondCharacter.id,
        }),
      },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: outbox.id },
      data: {
        status: "pending",
        deliveredAt: null,
        nextRunAt: new Date("2000-01-01T00:00:00Z"),
      },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({
      delivered: 0,
      failed: 1,
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: outbox.id },
    })).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      deliveredAt: null,
      lastError: {
        outcome: "quarantined",
        reason: "payload_hash_conflict",
        sourceService: "chat",
        sourceEventId,
      },
    });
    await expect(prisma.characterStats.findMany({
      where: { characterId: { in: [firstCharacter.id, secondCharacter.id] } },
      orderBy: { characterId: "asc" },
      select: { characterId: true, chatsCount: true },
    })).resolves.toEqual([
      { characterId: firstCharacter.id, chatsCount: 1 },
      { characterId: secondCharacter.id, chatsCount: 0 },
    ]);
  });

  it("terminally fails an outbox row whose canonical event is missing", async () => {
    const outboxId = `${prefix}-missing-canonical-outbox`;
    const canonicalEventId = `${prefix}-missing-canonical`;
    await prisma.mainOutboxEvent.create({
      data: {
        id: outboxId,
        eventType: "product.event.persisted.v2",
        aggregateType: "product_event",
        aggregateId: canonicalEventId,
        status: "pending",
        nextRunAt: new Date("1900-01-01T00:00:00Z"),
        createdAt: new Date("1900-01-01T00:00:00Z"),
        payload: {
          eventId: canonicalEventId,
          sourceService: "chat",
          sourceEventId: `${prefix}-missing-canonical-source`,
        },
      },
    });

    await expect(dispatchOutboxes([outboxId])).resolves.toEqual({
      delivered: 0,
      failed: 1,
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: outboxId },
    })).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      deliveredAt: null,
      lastError: {
        outcome: "failed",
        reason: "canonical_product_event_missing",
        canonicalEventId,
      },
    });
  });

  it("keeps an out-of-order outcome pending and delivers it after the prerequisite fact arrives", async () => {
    const sourceEventId = `${prefix}-subscription-ended`;
    const subscriptionId = `${prefix}-subscription`;
    const { outbox } = await persistEvent({
      sourceEventId,
      eventType: "subscription.ended.v2",
      occurredAt: new Date("2026-07-03T00:00:00Z"),
      props: { subscriptionId, userId },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({ delivered: 0, failed: 1 });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outbox.id } })).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      deliveredAt: null,
    });
    await expect(prisma.metricProjectionReceipt.findUnique({
      where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId } },
    })).resolves.toBeNull();

    await projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-subscription-activated-canonical`,
      sourceService: "main",
      sourceEventId: `${prefix}-subscription-activated`,
      name: "subscription.activated.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-02T00:00:00Z"),
      ingestedAt: new Date("2026-07-02T00:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: {},
      props: { subscriptionId, userId, planId: "premium-monthly" },
    });
    await prisma.mainOutboxEvent.update({
      where: { id: outbox.id },
      data: { nextRunAt: new Date("2000-01-01T00:00:00Z") },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({ delivered: 1, failed: 0 });
    await expect(prisma.subscriptionLifecycleFact.findUniqueOrThrow({ where: { subscriptionId } })).resolves.toMatchObject({
      endedAt: new Date("2026-07-03T00:00:00Z"),
    });
  });

  it("requeues a quarantined outcome and projects it after authority is repaired", async () => {
    const sourceEventId = `${prefix}-generation-delivered`;
    const requestId = `${prefix}-request`;
    const assetId = `${prefix}-asset`;
    const attemptId = `${prefix}-attempt`;
    const artifactId = `${prefix}-artifact`;
    const { outbox } = await persistEvent({
      sourceEventId,
      eventType: "generation.delivery.completed.v2",
      occurredAt: new Date("2026-07-04T00:00:00Z"),
      context: { generationRequestId: requestId },
      props: {
        requestId,
        artifactId: assetId,
        userId,
        expectedOutputCount: 1,
        deliveredOutputCount: 1,
        valid: true,
        displayable: true,
      },
    });

    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({ delivered: 1, failed: 0 });
    await expect(prisma.metricProjectionReceipt.findUniqueOrThrow({
      where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId } },
    })).resolves.toMatchObject({ outcome: "quarantined", reason: "missing_required_fact" });

    const unresolvedSourceEventId = `${prefix}-generation-still-unresolved`;
    const { outbox: unresolvedOutbox } = await persistEvent({
      sourceEventId: unresolvedSourceEventId,
      eventType: "generation.delivery.completed.v2",
      occurredAt: new Date("2026-07-04T00:01:00Z"),
      context: { generationRequestId: `${prefix}-still-unresolved-request` },
      props: {
        requestId: `${prefix}-still-unresolved-request`,
        artifactId: `${prefix}-still-unresolved-asset`,
        userId,
        expectedOutputCount: 1,
        deliveredOutputCount: 1,
        valid: true,
        displayable: true,
      },
    });
    await expect(dispatchOutboxes([unresolvedOutbox.id])).resolves.toEqual({ delivered: 1, failed: 0 });

    await prisma.generationJob.create({
      data: {
        id: requestId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        deliveredOutputCount: 1,
        status: "completed",
      },
    });
    await prisma.generationAttempt.create({
      data: { id: attemptId, requestId, attemptNo: 1, status: "succeeded" },
    });
    await prisma.generationArtifact.create({
      data: {
        id: artifactId,
        attemptId,
        ordinal: 0,
        terminalRecordChecksum: "b".repeat(64),
        validationState: "valid",
        assetId,
      },
    });
    await prisma.generationDelivery.create({
      data: {
        id: `${prefix}-delivery`,
        requestId,
        artifactId,
        targetType: "user_library",
        targetId: userId,
        status: "delivered",
        deliveredAt: new Date("2026-07-04T00:00:00Z"),
      },
    });

    await expect(requeueQuarantinedMetricEvent(prisma, { sourceService: "main", sourceEventId })).resolves.toEqual({
      status: "requeued",
      outboxCount: 1,
    });
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outbox.id } })).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
      deliveredAt: null,
    });
    await expect(prisma.dataQualityCheck.findFirstOrThrow({
      where: {
        checkKey: "metrics.server_outcome_completeness",
        evidence: { path: ["sourceEventId"], equals: sourceEventId },
      },
    })).resolves.toMatchObject({ status: "rechecking" });
    await expect(dispatchOutboxes([outbox.id])).resolves.toEqual({ delivered: 1, failed: 0 });
    await expect(prisma.generationFulfillmentFact.findUniqueOrThrow({ where: { requestId } })).resolves.toMatchObject({
      eligible: true,
      artifactId: assetId,
    });
    await expect(prisma.dataQualityCheck.findFirstOrThrow({
      where: {
        checkKey: "metrics.server_outcome_completeness",
        evidence: { path: ["sourceEventId"], equals: sourceEventId },
      },
    })).resolves.toMatchObject({
      status: "passed",
      observed: { quarantinedOutcomeCount: 0, resolved: true },
    });
    const completenessChecks = await prisma.dataQualityCheck.findMany({
      where: { checkKey: "metrics.server_outcome_completeness" },
    });
    const generationGate = selectQualityChecksForMetric(completenessChecks, "guardrail.wscru");
    expect(generationGate.get("metrics.server_outcome_completeness")).toMatchObject({
      status: "failed",
      evidence: expect.objectContaining({ sourceEventId: unresolvedSourceEventId }),
    });
  });
});
