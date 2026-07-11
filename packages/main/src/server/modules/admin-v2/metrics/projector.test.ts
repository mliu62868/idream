import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPrometheusMetrics, resetMetricsForTests } from "@idream/shared";
import { prisma } from "@/server/lib/db";
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
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceEventId: { startsWith: prefix } } });
    await prisma.chatExchangeFact.deleteMany({ where: { userId } });
    await prisma.generationFulfillmentFact.deleteMany({ where: { userId } });
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
      dataClass: "internal",
    })).resolves.toMatchObject({ status: "skipped", reason: "ineligible_data" });
  });

  it("projects signup, subscription, and successful delivery facts and reports zero duplicate effect", async () => {
    const common = {
      sourceService: "main",
      schemaVersion: 2,
      ingestedAt: new Date("2026-07-02T00:00:01Z"),
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
        props: { requestId: `${prefix}-request`, artifactId: `${prefix}-artifact`, userId, valid: true, displayable: true },
      },
    ];
    for (const event of events) {
      await expect(projectCanonicalMetricEvent(prisma, event)).resolves.toMatchObject({ status: "applied" });
    }

    const data = await loadCanonicalMetricDataset(prisma, { userIds: [userId] });
    expect(data.signups).toHaveLength(1);
    expect(data.subscriptions).toEqual([expect.objectContaining({ subscriptionId: `${prefix}-sub`, eligible: true })]);
    expect(data.generationDeliveries).toEqual([expect.objectContaining({ requestId: `${prefix}-request`, eligible: true })]);

    const report = await reconcileCanonicalMetricFacts(prisma, { sourceEventPrefix: prefix });
    expect(report).toMatchObject({ duplicateEffectCount: 0, impossibleStateCount: 0 });
    expect(report.userJoinCoverage).toBe(1);
    expect(report.characterJoinCoverage).toBe(0);
    expect(report.joinCoverage).toBe(0);
    expect(report.qualityState).toBe("invalid");
  });
});
