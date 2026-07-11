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
      actor: { isInternal: false },
      context: {},
      props,
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
});
