import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { evaluateCanonicalMetrics } from "./engine";
import {
  loadCanonicalMetricDataset,
  projectCanonicalMetricEvent,
  reconcileCanonicalMetricFacts,
} from "./projector";

describe("canonical metric fact projector", () => {
  const prefix = `metric-projector-${randomUUID()}`;
  const userId = `${prefix}-user`;

  beforeAll(async () => {
    resetMetricsForTests();
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test`, role: "user", status: "active" },
    });
  });

  afterAll(async () => {
    const qualityChecks = await prisma.dataQualityCheck.findMany({
      where: { checkKey: "metrics.server_outcome_completeness" },
      select: { id: true, evidence: true },
    });
    await prisma.dataQualityCheck.deleteMany({
      where: {
        id: {
          in: qualityChecks.flatMap((check) => {
            const evidence = check.evidence;
            if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return [];
            const sourceEventId = (evidence as Record<string, unknown>).sourceEventId;
            return typeof sourceEventId === "string" && sourceEventId.startsWith(prefix) ? [check.id] : [];
          }),
        },
      },
    });
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
    await prisma.chatExchangeFact.deleteMany({ where: { userId } });
    await prisma.generationFulfillmentFact.deleteMany({ where: { userId } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: { startsWith: prefix } } });
    await prisma.generationArtifact.deleteMany({ where: { attemptId: { startsWith: prefix } } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { startsWith: prefix } } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: { startsWith: prefix } } });
    await prisma.generationJob.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.subscriptionLifecycleFact.deleteMany({ where: { userId } });
    await prisma.customerSignupFact.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("projects typed completed exchanges idempotently and applies a later correction without guessing release context", async () => {
    const completed = {
      id: `${prefix}-canonical-completed`,
      sourceService: "chat",
      sourceEventId: `${prefix}-completed`,
      name: "chat.exchange.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-01T12:00:00Z"),
      ingestedAt: new Date("2026-07-01T12:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: { characterId: "character-v2", characterContentVersionId: "content-v4", characterReleaseId: null },
      props: {
        exchangeId: `${prefix}-exchange`,
        userMessageId: `${prefix}-user-message`,
        assistantMessageId: `${prefix}-assistant-message`,
        selectedAssistantMessageId: `${prefix}-assistant-message`,
        assistantAttemptNo: 1,
        isRegeneration: false,
        sessionId: `${prefix}-chat-session`,
        engagementSessionId: `${prefix}-engagement-session`,
        userId,
        characterId: "character-v2",
        characterContentVersionId: "content-v4",
        characterReleaseId: null,
      },
    } as const;

    await expect(projectCanonicalMetricEvent(prisma, completed)).resolves.toMatchObject({ status: "applied", factType: "chat_exchange" });
    await expect(projectCanonicalMetricEvent(prisma, completed)).resolves.toMatchObject({ status: "duplicate", factType: "chat_exchange" });
    const projectionMetrics = renderPrometheusMetrics();
    expect(projectionMetrics).toContain('projection_total{outcome="applied",projection="canonical_metrics"} 1');
    expect(projectionMetrics).toContain('projection_total{outcome="duplicate",projection="canonical_metrics"} 1');
    expect(projectionMetrics).toContain('projection_lag_seconds_count{projection="canonical_metrics"} 2');

    const before = await loadCanonicalMetricDataset(prisma, { userIds: [userId] });
    expect(before.chatExchanges).toEqual([
      expect.objectContaining({
        exchangeId: `${prefix}-exchange`,
        characterId: "character-v2",
        engagementSessionId: `${prefix}-engagement-session`,
        eligible: true,
      }),
    ]);

    await expect(projectCanonicalMetricEvent(prisma, {
      ...completed,
      id: `${prefix}-canonical-correction`,
      sourceEventId: `${prefix}-correction`,
      name: "chat.exchange.corrected.v2",
      occurredAt: new Date("2026-07-01T12:05:00Z"),
      props: {
        exchangeId: `${prefix}-exchange`,
        correctionType: "deleted",
        correctionRevision: 2,
        userId,
      },
    })).resolves.toMatchObject({ status: "applied", factType: "chat_exchange_correction" });

    const after = await loadCanonicalMetricDataset(prisma, { userIds: [userId] });
    expect(after.chatExchanges).toEqual([
      expect.objectContaining({ exchangeId: `${prefix}-exchange`, eligible: false }),
    ]);
  });

  it("replays regenerate, edit, delete, and selection corrections into exact activation and D1 metrics", async () => {
    const replayId = `${prefix}-golden-replay`;
    const replayUserId = `${replayId}-user`;
    const characterId = `${replayId}-character`;
    const d0 = new Date("2026-06-01T08:00:00.000Z");
    const d1 = new Date("2026-06-02T08:00:00.000Z");
    let sourceSequence = 0;

    const completedEvent = (input: {
      readonly exchangeId: string;
      readonly occurredAt: Date;
      readonly sessionId: string;
      readonly attemptNo?: number;
      readonly isRegeneration?: boolean;
    }) => {
      sourceSequence += 1;
      const attemptNo = input.attemptNo ?? 1;
      const assistantMessageId = `${input.exchangeId}-assistant-${attemptNo}`;
      return {
        id: `${replayId}-canonical-${sourceSequence}`,
        sourceService: "chat",
        sourceEventId: `${replayId}-source-${sourceSequence}`,
        name: "chat.exchange.completed.v2",
        schemaVersion: 2,
        occurredAt: input.occurredAt,
        ingestedAt: new Date(input.occurredAt.getTime() + 1_000),
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actor: { userId: replayUserId, isInternal: false },
        context: { characterId, characterContentVersionId: `${characterId}-content`, characterReleaseId: null },
        props: {
          exchangeId: input.exchangeId,
          userMessageId: `${input.exchangeId}-user`,
          assistantMessageId,
          selectedAssistantMessageId: assistantMessageId,
          assistantAttemptNo: attemptNo,
          isRegeneration: input.isRegeneration ?? false,
          sessionId: input.sessionId,
          engagementSessionId: input.sessionId,
          userId: replayUserId,
          characterId,
          characterContentVersionId: `${characterId}-content`,
          characterReleaseId: null,
        },
      } as const;
    };

    const correctionEvent = (input: {
      readonly exchangeId: string;
      readonly correctionType: "selected" | "edited" | "deleted" | "superseded";
      readonly correctionRevision: number;
      readonly occurredAt: Date;
      readonly selectedAssistantMessageId?: string;
    }) => {
      sourceSequence += 1;
      return {
        id: `${replayId}-canonical-${sourceSequence}`,
        sourceService: "chat",
        sourceEventId: `${replayId}-source-${sourceSequence}`,
        name: "chat.exchange.corrected.v2",
        schemaVersion: 2,
        occurredAt: input.occurredAt,
        ingestedAt: new Date(input.occurredAt.getTime() + 1_000),
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actor: { userId: replayUserId, isInternal: false },
        context: { characterId },
        props: {
          exchangeId: input.exchangeId,
          correctionType: input.correctionType,
          correctionRevision: input.correctionRevision,
          selectedAssistantMessageId: input.selectedAssistantMessageId,
          userId: replayUserId,
        },
      } as const;
    };

    await prisma.user.create({
      data: { id: replayUserId, email: `${replayUserId}@example.test`, role: "user", status: "active" },
    });
    try {
      sourceSequence += 1;
      await projectCanonicalMetricEvent(prisma, {
        id: `${replayId}-canonical-${sourceSequence}`,
        sourceService: "main",
        sourceEventId: `${replayId}-source-${sourceSequence}`,
        name: "customer.signup.completed.v2",
        schemaVersion: 2,
        occurredAt: new Date("2026-06-01T00:00:00.000Z"),
        ingestedAt: new Date("2026-06-01T00:00:01.000Z"),
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actor: { userId: replayUserId, isInternal: false },
        context: {},
        props: { userId: replayUserId },
      });

      for (let index = 0; index < 5; index += 1) {
        await projectCanonicalMetricEvent(prisma, completedEvent({
          exchangeId: `${replayId}-d0-${index}`,
          occurredAt: new Date(d0.getTime() + index * 1_000),
          sessionId: `${replayId}-d0-session`,
        }));
      }
      await projectCanonicalMetricEvent(prisma, completedEvent({
        exchangeId: `${replayId}-d0-0`,
        occurredAt: new Date(d0.getTime() + 10_000),
        sessionId: `${replayId}-d0-session`,
        attemptNo: 2,
        isRegeneration: true,
      }));
      await projectCanonicalMetricEvent(prisma, correctionEvent({
        exchangeId: `${replayId}-d0-4`,
        correctionType: "edited",
        correctionRevision: 2,
        occurredAt: new Date(d0.getTime() + 20_000),
      }));
      await projectCanonicalMetricEvent(prisma, correctionEvent({
        exchangeId: `${replayId}-d0-4`,
        correctionType: "selected",
        correctionRevision: 3,
        selectedAssistantMessageId: `${replayId}-d0-4-assistant-1`,
        occurredAt: new Date(d0.getTime() + 21_000),
      }));
      await projectCanonicalMetricEvent(prisma, correctionEvent({
        exchangeId: `${replayId}-d0-3`,
        correctionType: "deleted",
        correctionRevision: 2,
        occurredAt: new Date(d0.getTime() + 22_000),
      }));
      await projectCanonicalMetricEvent(prisma, completedEvent({
        exchangeId: `${replayId}-d0-3`,
        occurredAt: new Date(d0.getTime() + 23_000),
        sessionId: `${replayId}-d0-session`,
        attemptNo: 2,
        isRegeneration: true,
      }));
      await projectCanonicalMetricEvent(prisma, completedEvent({
        exchangeId: `${replayId}-d0-replacement`,
        occurredAt: new Date(d0.getTime() + 24_000),
        sessionId: `${replayId}-d0-session`,
      }));
      for (let index = 0; index < 5; index += 1) {
        await projectCanonicalMetricEvent(prisma, completedEvent({
          exchangeId: `${replayId}-d1-${index}`,
          occurredAt: new Date(d1.getTime() + index * 1_000),
          sessionId: `${replayId}-d1-session`,
        }));
      }

      const canonical = await loadCanonicalMetricDataset(prisma, { userIds: [replayUserId] });
      expect(canonical.chatExchanges.filter((exchange) => exchange.eligible)).toHaveLength(10);
      expect(canonical.chatExchanges).toEqual(expect.arrayContaining([
        expect.objectContaining({ exchangeId: `${replayId}-d0-0`, eligible: true }),
        expect.objectContaining({ exchangeId: `${replayId}-d0-3`, eligible: false }),
        expect.objectContaining({ exchangeId: `${replayId}-d0-4`, eligible: true }),
      ]));
      const metrics = evaluateCanonicalMetrics(canonical, new Date("2026-06-10T00:00:00.000Z"));
      expect(metrics.metrics["activation.chat_24h"]).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
      expect(metrics.metrics["retention.same_character_d1"]).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
      expect(metrics.qualifiedEpisodes).toHaveLength(2);
    } finally {
      await prisma.companionEngagementDaily.deleteMany({ where: { userId: replayUserId } });
      await prisma.chatExchangeFact.deleteMany({ where: { userId: replayUserId } });
      await prisma.customerSignupFact.deleteMany({ where: { userId: replayUserId } });
      await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { startsWith: replayId } } });
      await prisma.user.deleteMany({ where: { id: replayUserId } });
    }
  });

  it("fails closed for untyped legacy messages and non-customer/internal events", async () => {
    const base = {
      id: `${prefix}-canonical-legacy`,
      sourceService: "chat",
      sourceEventId: `${prefix}-legacy`,
      name: "chat.message.completed",
      schemaVersion: 1,
      occurredAt: new Date("2026-07-01T12:00:00Z"),
      ingestedAt: new Date("2026-07-01T12:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: { characterId: "character-v2" },
      props: { userId, characterId: "character-v2" },
    } as const;
    await expect(projectCanonicalMetricEvent(prisma, base)).resolves.toMatchObject({ status: "skipped", reason: "legacy_untyped" });
    await expect(projectCanonicalMetricEvent(prisma, {
      ...base,
      id: `${prefix}-canonical-internal`,
      sourceEventId: `${prefix}-internal`,
      name: "chat.exchange.completed.v2",
      schemaVersion: 2,
      dataClass: "internal",
    })).resolves.toMatchObject({ status: "skipped", reason: "ineligible_data" });
  });

  it("quarantines an authoritative outcome with an unknown schema version", async () => {
    const sourceEventId = `${prefix}-unknown-schema`;
    await expect(projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-unknown-schema`,
      sourceService: "main",
      sourceEventId,
      name: "customer.signup.completed.v2",
      schemaVersion: 3,
      occurredAt: new Date("2026-07-01T00:00:00Z"),
      ingestedAt: new Date("2026-07-01T00:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: {},
      props: { userId },
    })).resolves.toEqual({ status: "quarantined", reason: "unsupported_schema_version" });

    await expect(prisma.metricProjectionReceipt.findUniqueOrThrow({
      where: { sourceService_sourceEventId: { sourceService: "main", sourceEventId } },
    })).resolves.toMatchObject({
      outcome: "quarantined",
      reason: "unsupported_schema_version",
    });
    await expect(reconcileCanonicalMetricFacts(prisma, { sourceEventPrefix: sourceEventId })).resolves.toMatchObject({
      incompleteOutcomeCount: 1,
      qualityState: "invalid",
    });
    await expect(prisma.dataQualityCheck.findFirstOrThrow({
      where: {
        checkKey: "metrics.server_outcome_completeness",
        evidence: { path: ["sourceEventId"], equals: sourceEventId },
      },
    })).resolves.toMatchObject({
      status: "failed",
      metricKeys: expect.arrayContaining(["activation.chat_24h"]),
    });
    await expect(loadCanonicalMetricDataset(prisma, { userIds: [userId] })).resolves.toMatchObject({ signups: [] });
  });

  it("quarantines a generation outcome without required fulfillment facts", async () => {
    const sourceEventId = `${prefix}-missing-fulfillment-window`;
    await expect(projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-missing-fulfillment-window`,
      sourceService: "main",
      sourceEventId,
      name: "generation.delivery.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-02T01:00:00Z"),
      ingestedAt: new Date("2026-07-02T01:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: { generationRequestId: `${prefix}-incomplete-request` },
      props: {
        requestId: `${prefix}-incomplete-request`,
        artifactId: `${prefix}-incomplete-artifact`,
        userId,
        valid: true,
        displayable: true,
      },
    })).resolves.toEqual({ status: "quarantined", reason: "incomplete_outcome_payload" });

    await expect(loadCanonicalMetricDataset(prisma, { userIds: [userId] })).resolves.toMatchObject({
      generationDeliveries: [],
    });
  });

  it("quarantines an impossible generation fulfillment outcome", async () => {
    await expect(projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-impossible-fulfillment`,
      sourceService: "main",
      sourceEventId: `${prefix}-impossible-fulfillment`,
      name: "generation.delivery.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-02T02:00:00Z"),
      ingestedAt: new Date("2026-07-02T02:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: { generationRequestId: `${prefix}-impossible-request` },
      props: {
        requestId: `${prefix}-impossible-request`,
        artifactId: `${prefix}-impossible-artifact`,
        userId,
        expectedOutputCount: 1,
        deliveredOutputCount: 2,
        valid: true,
        displayable: true,
      },
    })).resolves.toEqual({ status: "quarantined", reason: "incomplete_outcome_payload" });

    await expect(loadCanonicalMetricDataset(prisma, { userIds: [userId] })).resolves.toMatchObject({
      generationDeliveries: [],
    });
  });

  it("quarantines a generation outcome without matching request, attempt, artifact, and delivery authority", async () => {
    await expect(projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-unbacked-fulfillment`,
      sourceService: "main",
      sourceEventId: `${prefix}-unbacked-fulfillment`,
      name: "generation.delivery.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-02T03:00:00Z"),
      ingestedAt: new Date("2026-07-02T03:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: { generationRequestId: `${prefix}-unbacked-request` },
      props: {
        requestId: `${prefix}-unbacked-request`,
        artifactId: `${prefix}-unbacked-asset`,
        userId,
        expectedOutputCount: 1,
        deliveredOutputCount: 1,
        valid: true,
        displayable: true,
      },
    })).resolves.toEqual({ status: "quarantined", reason: "missing_required_fact" });

    await expect(loadCanonicalMetricDataset(prisma, { userIds: [userId] })).resolves.toMatchObject({
      generationDeliveries: [],
    });
  });

  it("rejects gen-originated delivery outcomes because main owns delivery authority", async () => {
    await expect(projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-gen-delivery`,
      sourceService: "gen",
      sourceEventId: `${prefix}-gen-delivery`,
      name: "generation.delivery.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-02T03:30:00Z"),
      ingestedAt: new Date("2026-07-02T03:30:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: { generationRequestId: `${prefix}-gen-owned-request` },
      props: {
        requestId: `${prefix}-gen-owned-request`,
        artifactId: `${prefix}-gen-owned-artifact`,
        userId,
        expectedOutputCount: 1,
        deliveredOutputCount: 1,
        valid: true,
        displayable: true,
      },
    })).resolves.toEqual({ status: "quarantined", reason: "invalid_source_identity" });
  });

  it("quarantines an authoritative outcome without a valid source identity", async () => {
    const sourceEventId = `${prefix}-invalid-source`;
    await expect(projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-invalid-source`,
      sourceService: "web",
      sourceEventId,
      name: "customer.signup.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-01T00:00:00Z"),
      ingestedAt: new Date("2026-07-01T00:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: {},
      props: { userId },
    })).resolves.toEqual({ status: "quarantined", reason: "invalid_source_identity" });

    await expect(loadCanonicalMetricDataset(prisma, { userIds: [userId] })).resolves.toMatchObject({ signups: [] });
  });

  it("quarantines an outcome whose source occurrence is outside the ingest clock-skew window", async () => {
    await expect(projectCanonicalMetricEvent(prisma, {
      id: `${prefix}-canonical-invalid-time-window`,
      sourceService: "main",
      sourceEventId: `${prefix}-invalid-time-window`,
      name: "customer.signup.completed.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-01T00:10:01Z"),
      ingestedAt: new Date("2026-07-01T00:00:00Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: {},
      props: { userId },
    })).resolves.toEqual({ status: "quarantined", reason: "invalid_outcome_time_window" });

    await expect(loadCanonicalMetricDataset(prisma, { userIds: [userId] })).resolves.toMatchObject({ signups: [] });
  });

  it("defers an out-of-order terminal outcome and recovers after its authority fact arrives", async () => {
    const endedEvent = {
      id: `${prefix}-canonical-orphan-subscription-end`,
      sourceService: "main",
      sourceEventId: `${prefix}-orphan-subscription-end`,
      name: "subscription.ended.v2",
      schemaVersion: 2,
      occurredAt: new Date("2026-07-03T00:00:00Z"),
      ingestedAt: new Date("2026-07-03T00:00:01Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: {},
      props: { subscriptionId: `${prefix}-missing-subscription`, userId },
    } as const;
    await expect(projectCanonicalMetricEvent(prisma, endedEvent)).resolves.toEqual({
      status: "deferred",
      reason: "awaiting_required_fact",
    });
    await expect(prisma.metricProjectionReceipt.findUnique({
      where: {
        sourceService_sourceEventId: {
          sourceService: endedEvent.sourceService,
          sourceEventId: endedEvent.sourceEventId,
        },
      },
    })).resolves.toBeNull();

    await expect(projectCanonicalMetricEvent(prisma, {
      ...endedEvent,
      id: `${prefix}-canonical-orphan-subscription-activation`,
      sourceEventId: `${prefix}-orphan-subscription-activation`,
      name: "subscription.activated.v2",
      occurredAt: new Date("2026-07-02T00:00:00Z"),
      props: { subscriptionId: `${prefix}-missing-subscription`, userId, planId: "premium-monthly" },
    })).resolves.toMatchObject({ status: "applied" });
    await expect(projectCanonicalMetricEvent(prisma, endedEvent)).resolves.toMatchObject({ status: "applied" });

    await expect(loadCanonicalMetricDataset(prisma, { userIds: [userId] })).resolves.toMatchObject({
      subscriptions: [expect.objectContaining({ endedAt: endedEvent.occurredAt })],
    });
    await prisma.subscriptionLifecycleFact.delete({
      where: { subscriptionId: `${prefix}-missing-subscription` },
    });
  });

  it("projects signup, subscription, and successful delivery facts and reports zero duplicate effect", async () => {
    const requestId = `${prefix}-request`;
    const assetId = `${prefix}-artifact`;
    const attemptId = `${prefix}-attempt`;
    const artifactAuthorityId = `${prefix}-artifact-authority`;
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
        id: artifactAuthorityId,
        attemptId,
        ordinal: 0,
        terminalRecordChecksum: "a".repeat(64),
        validationState: "valid",
        assetId,
      },
    });
    await prisma.generationDelivery.create({
      data: {
        id: `${prefix}-delivery-authority`,
        requestId,
        artifactId: artifactAuthorityId,
        targetType: "user_library",
        targetId: userId,
        status: "delivered",
        deliveredAt: new Date("2026-07-02T01:00:00Z"),
      },
    });
    const common = {
      sourceService: "main",
      schemaVersion: 2,
      ingestedAt: new Date("2026-07-05T00:00:00Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId, isInternal: false },
      context: {},
    } as const;
    const events = [
      {
        ...common,
        id: `${prefix}-canonical-signup`,
        sourceEventId: `${prefix}-signup`,
        name: "customer.signup.completed.v2",
        occurredAt: new Date("2026-07-01T00:00:00Z"),
        props: { userId },
      },
      {
        ...common,
        id: `${prefix}-canonical-subscription`,
        sourceEventId: `${prefix}-subscription`,
        name: "subscription.activated.v2",
        occurredAt: new Date("2026-07-02T00:00:00Z"),
        props: { subscriptionId: `${prefix}-sub`, userId, planId: "premium-monthly" },
      },
      {
        ...common,
        id: `${prefix}-canonical-delivery`,
        sourceEventId: `${prefix}-delivery`,
        name: "generation.delivery.completed.v2",
        occurredAt: new Date("2026-07-02T01:00:00Z"),
        context: { characterId: "character-v2", characterReleaseId: null },
        props: {
          requestId,
          artifactId: assetId,
          userId,
          expectedOutputCount: 1,
          deliveredOutputCount: 1,
          valid: true,
          displayable: true,
        },
      },
    ];
    for (const event of events) {
      await expect(projectCanonicalMetricEvent(prisma, event)).resolves.toMatchObject({ status: "applied" });
    }
    await projectCanonicalMetricEvent(prisma, {
      ...common,
      id: `${prefix}-canonical-subscription-ended`,
      sourceEventId: `${prefix}-subscription-ended`,
      name: "subscription.ended.v2",
      occurredAt: new Date("2026-07-03T00:00:00Z"),
      props: { subscriptionId: `${prefix}-sub`, userId, reason: "test_end" },
    });
    await projectCanonicalMetricEvent(prisma, {
      ...common,
      id: `${prefix}-canonical-subscription-reactivated`,
      sourceEventId: `${prefix}-subscription-reactivated`,
      name: "subscription.activated.v2",
      occurredAt: new Date("2026-07-04T00:00:00Z"),
      props: { subscriptionId: `${prefix}-sub`, userId, planId: "premium-monthly" },
    });

    const data = await loadCanonicalMetricDataset(prisma, { userIds: [userId] });
    expect(data.signups).toHaveLength(1);
    expect(data.subscriptions).toEqual([expect.objectContaining({
      subscriptionId: `${prefix}-sub`,
      eligible: true,
      activeAt: new Date("2026-07-02T00:00:00Z"),
      endedAt: null,
    })]);
    expect(data.generationDeliveries).toEqual([expect.objectContaining({ requestId: `${prefix}-request`, eligible: true })]);

    const report = await reconcileCanonicalMetricFacts(prisma, { sourceEventPrefix: prefix });
    expect(report).toMatchObject({ duplicateEffectCount: 0, impossibleStateCount: 0 });
    expect(report.userJoinCoverage).toBe(1);
    expect(report.characterJoinCoverage).toBe(0);
    expect(report.joinCoverage).toBe(0);
    expect(report.qualityState).toBe("invalid");
  });
});
