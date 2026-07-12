import { randomUUID } from "node:crypto";
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
    await prisma.mainOutboxEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.analyticsEvent.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
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
  }) {
    const event = await prisma.analyticsEvent.create({
      data: {
        id: `${input.sourceEventId}-canonical`,
        name: input.eventType,
        props: toInputJson(input.props),
        sourceService: "main",
        sourceEventId: input.sourceEventId,
        schemaVersion: 2,
        occurredAt: input.occurredAt,
        ingestedAt: new Date(input.occurredAt.getTime() + 1_000),
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actor: { userId, isInternal: false },
        context: toInputJson(input.context ?? {}),
      },
    });
    const outbox = await prisma.mainOutboxEvent.create({
      data: {
        id: `${input.sourceEventId}-outbox`,
        eventType: "product.event.persisted.v2",
        aggregateType: "product_event",
        aggregateId: event.id,
        status: "pending",
        nextRunAt: new Date("2000-01-01T00:00:00Z"),
        createdAt: new Date("2000-01-01T00:00:00Z"),
        payload: { eventId: event.id, sourceService: "main", sourceEventId: input.sourceEventId },
      },
    });
    return { event, outbox };
  }

  it("keeps an out-of-order outcome pending and delivers it after the prerequisite fact arrives", async () => {
    const sourceEventId = `${prefix}-subscription-ended`;
    const subscriptionId = `${prefix}-subscription`;
    const { outbox } = await persistEvent({
      sourceEventId,
      eventType: "subscription.ended.v2",
      occurredAt: new Date("2026-07-03T00:00:00Z"),
      props: { subscriptionId, userId },
    });

    await expect(dispatchPendingProductEvents(1)).resolves.toEqual({ delivered: 0, failed: 1 });
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

    await expect(dispatchPendingProductEvents(1)).resolves.toEqual({ delivered: 1, failed: 0 });
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

    await expect(dispatchPendingProductEvents(1)).resolves.toEqual({ delivered: 1, failed: 0 });
    await expect(prisma.metricProjectionReceipt.findUniqueOrThrow({
      where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId } },
    })).resolves.toMatchObject({ outcome: "quarantined", reason: "missing_required_fact" });

    const unresolvedSourceEventId = `${prefix}-generation-still-unresolved`;
    await persistEvent({
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
    await expect(dispatchPendingProductEvents(1)).resolves.toEqual({ delivered: 1, failed: 0 });

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
        manifestChecksum: "b".repeat(64),
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
    await expect(dispatchPendingProductEvents(1)).resolves.toEqual({ delivered: 1, failed: 0 });
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
