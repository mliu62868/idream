import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { METRIC_PRODUCT_EVENTS } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { projectCanonicalMetricEvent, type MetricProductEvent } from "../metrics/projector";

describe("Character exposure v2 attribution projector", () => {
  const suffix = randomUUID();
  const characterId = `exposure-character-${suffix}`;
  const contentId = `exposure-content-${suffix}`;
  const projectId = `exposure-project-${suffix}`;
  const releaseId = `exposure-release-${suffix}`;
  const sourceIds: string[] = [];

  function event(sourceEventId: string, props: Record<string, unknown>): MetricProductEvent {
    sourceIds.push(sourceEventId);
    return {
      id: `canonical-${sourceEventId}`,
      sourceService: "web",
      sourceEventId,
      name: METRIC_PRODUCT_EVENTS.characterExposureRecorded,
      schemaVersion: 2,
      occurredAt: new Date("2026-07-10T00:00:00.000Z"),
      ingestedAt: new Date("2026-07-10T00:00:01.000Z"),
      environment: "production",
      dataClass: "customer",
      trustClass: "typed_client",
      actor: { userId: `exposure-user-${suffix}`, isInternal: false },
      context: {},
      props,
    };
  }

  function exchangeEvent(
    sourceEventId: string,
    index: number,
    attribution: { entryExposureId: string; journeyId: string; placementId: string },
  ): MetricProductEvent {
    sourceIds.push(sourceEventId);
    return {
      id: `canonical-${sourceEventId}`,
      sourceService: "chat",
      sourceEventId,
      name: METRIC_PRODUCT_EVENTS.chatExchangeCompleted,
      schemaVersion: 2,
      occurredAt: new Date(`2026-07-10T00:0${index}:00.000Z`),
      ingestedAt: new Date(`2026-07-10T00:0${index}:01.000Z`),
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actor: { userId: `exposure-user-${suffix}`, isInternal: false },
      context: {},
      props: {
        exchangeId: `exposure-exchange-${suffix}-${index}`,
        userMessageId: `exposure-user-message-${suffix}-${index}`,
        assistantMessageId: `exposure-assistant-message-${suffix}-${index}`,
        selectedAssistantMessageId: `exposure-assistant-message-${suffix}-${index}`,
        assistantAttemptNo: 1,
        isRegeneration: false,
        sessionId: `exposure-chat-session-${suffix}`,
        engagementSessionId: `exposure-engagement-${suffix}`,
        userId: `exposure-user-${suffix}`,
        characterId,
        characterContentVersionId: contentId,
        characterReleaseId: releaseId,
        ...attribution,
      },
    };
  }

  beforeAll(async () => {
    await prisma.characterContentVersion.create({
      data: { id: contentId, characterId, version: 1, contentHash: `exposure-hash-${suffix}`, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" },
    });
    await prisma.characterProject.create({
      data: { id: projectId, characterId, phase: "live_management", audience: {}, successCriteria: [] },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `exposure-revision-${suffix}`,
        characterContentVersionId: contentId,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `exposure-snapshot-${suffix}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceService: "web", sourceEventId: { in: sourceIds } } });
    await prisma.metricProjectionReceipt.deleteMany({ where: { sourceService: "chat", sourceEventId: { in: sourceIds } } });
    await prisma.characterFunnelDaily.deleteMany({ where: { characterId } });
    await prisma.chatExchangeFact.deleteMany({ where: { characterId } });
    await prisma.characterExposureFact.deleteMany({ where: { characterId } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.characterContentVersion.delete({ where: { id: contentId } });
    await prisma.$disconnect();
  });

  it("persists an eligible impression and its exact detail chain", async () => {
    const impressionId = `exposure-impression-${suffix}`;
    expect(await projectCanonicalMetricEvent(prisma, event(`exposure-impression-event-${suffix}`, {
      exposureId: impressionId,
      eventType: "eligible_impression",
      userId: `exposure-user-${suffix}`,
      journeyId: `exposure-journey-${suffix}`,
      characterId,
      characterContentVersionId: contentId,
      characterReleaseId: releaseId,
      placementId: "feed.hero",
      visibleRatio: 0.75,
      visibleDurationMs: 700,
    }))).toMatchObject({ status: "applied", factType: "character_exposure" });
    expect(await projectCanonicalMetricEvent(prisma, event(`exposure-detail-event-${suffix}`, {
      exposureId: `exposure-detail-${suffix}`,
      eventType: "detail_view",
      parentExposureId: impressionId,
      userId: `exposure-user-${suffix}`,
      journeyId: `exposure-journey-${suffix}`,
      characterId,
      characterContentVersionId: contentId,
      characterReleaseId: releaseId,
      placementId: "feed.hero",
      visibleRatio: 1,
      visibleDurationMs: 0,
    }))).toMatchObject({ status: "applied", factType: "character_exposure" });
    expect(await prisma.characterExposureFact.count({ where: { characterId } })).toBe(2);
  });

  it("rejects a detail event that tries to borrow another placement's chain", async () => {
    expect(await projectCanonicalMetricEvent(prisma, event(`exposure-invalid-detail-event-${suffix}`, {
      exposureId: `exposure-invalid-detail-${suffix}`,
      eventType: "detail_view",
      parentExposureId: `exposure-impression-${suffix}`,
      userId: `exposure-user-${suffix}`,
      journeyId: `exposure-journey-${suffix}`,
      characterId,
      characterContentVersionId: contentId,
      characterReleaseId: releaseId,
      placementId: "search.result",
      visibleRatio: 1,
      visibleDurationMs: 0,
    }))).toEqual({ status: "skipped", reason: "invalid_exposure_chain" });
    expect(await prisma.characterExposureFact.findUnique({
      where: { exposureId: `exposure-invalid-detail-${suffix}` },
    })).toBeNull();
  });

  it("carries a verified detail entry into exact release/placement QCE projection", async () => {
    const journeyId = `exposure-qce-journey-${suffix}`;
    const impressionId = `exposure-qce-impression-${suffix}`;
    const detailId = `exposure-qce-detail-${suffix}`;
    const attribution = { entryExposureId: detailId, journeyId, placementId: "feed.qce" };
    await projectCanonicalMetricEvent(prisma, event(`exposure-qce-impression-event-${suffix}`, {
      exposureId: impressionId,
      eventType: "eligible_impression",
      userId: `exposure-user-${suffix}`,
      journeyId,
      characterId,
      characterContentVersionId: contentId,
      characterReleaseId: releaseId,
      placementId: "feed.qce",
      visibleRatio: 0.9,
      visibleDurationMs: 700,
    }));
    await projectCanonicalMetricEvent(prisma, event(`exposure-qce-detail-event-${suffix}`, {
      exposureId: detailId,
      eventType: "detail_view",
      parentExposureId: impressionId,
      userId: `exposure-user-${suffix}`,
      journeyId,
      characterId,
      characterContentVersionId: contentId,
      characterReleaseId: releaseId,
      placementId: "feed.qce",
      visibleRatio: 1,
      visibleDurationMs: 0,
    }));
    for (let index = 1; index <= 5; index += 1) {
      expect(await projectCanonicalMetricEvent(
        prisma,
        exchangeEvent(`exposure-qce-exchange-event-${suffix}-${index}`, index, attribution),
      )).toMatchObject({ status: "applied", factType: "chat_exchange" });
    }
    expect(await prisma.chatExchangeFact.count({
      where: { characterId, placementId: "feed.qce", coverageState: "exact" },
    })).toBe(5);
    expect(await prisma.characterFunnelDaily.findFirstOrThrow({
      where: {
        characterId,
        characterReleaseId: releaseId,
        placementId: "feed.qce",
        productDay: new Date("2026-07-10T00:00:00.000Z"),
      },
    })).toMatchObject({
      eligibleImpressions: 1,
      detailViews: 1,
      firstSuccessfulExchanges: 1,
      qceCount: 1,
      projectionVersion: 2,
      coverageState: "exact_through_same_character_d7_paid_attribution_unavailable",
    });
  });

  it("keeps a forged entry claim canonical but explicitly unattributed", async () => {
    const result = await projectCanonicalMetricEvent(
      prisma,
      exchangeEvent(`exposure-forged-exchange-event-${suffix}`, 6, {
        entryExposureId: `exposure-qce-detail-${suffix}`,
        journeyId: `forged-journey-${suffix}`,
        placementId: "feed.qce",
      }),
    );
    expect(result).toMatchObject({ status: "applied", factType: "chat_exchange" });
    expect(await prisma.chatExchangeFact.findUniqueOrThrow({
      where: { exchangeId: `exposure-exchange-${suffix}-6` },
    })).toMatchObject({
      coverageState: "exact_unattributed",
      entryExposureId: null,
      journeyId: null,
      placementId: null,
    });
  });
});
