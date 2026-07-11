import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  collectReleaseMonitorFacts,
  dispatchStaleReleaseRoutes,
  evaluateRouteQualification,
} from "./release-monitor";

describe("Release route qualification and post-publish monitor", () => {
  const suffix = randomUUID();
  const characterId = `monitor-character-${suffix}`;
  const projectId = `monitor-project-${suffix}`;
  const releaseId = `monitor-release-${suffix}`;
  const contentId = `monitor-content-${suffix}`;
  const qualificationId = `monitor-qualification-${suffix}`;
  const publishedAt = new Date("2026-07-07T00:00:00.000Z");
  const now = new Date("2026-07-11T00:00:00.000Z");

  beforeAll(async () => {
    await prisma.characterProject.create({
      data: { id: projectId, characterId, phase: "live_management", audience: {}, successCriteria: [] },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `revision-${suffix}`,
        characterContentVersionId: contentId,
        generationProvenance: { routeFingerprint: `route-${suffix}` },
        releasePlacementManifest: {},
        snapshotHash: `snapshot-${suffix}`,
        readiness: "ready",
        status: "published",
        publishedAt,
        version: 3,
      },
    });
    await prisma.characterServing.create({
      data: {
        id: `serving-${suffix}`,
        characterId,
        currentReleaseId: releaseId,
        state: "live",
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: qualificationId,
        routeFingerprint: `route-${suffix}`,
        generationProfileKey: "profile",
        generationProfileVersion: 1,
        workflowKey: "workflow",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: "default",
        sampleCount: 40,
        passCount: 38,
        identityMatch: 0.95,
        result: "qualified",
        evidence: { evaluatorVersion: "eval-v1" },
        policyVersion: "policy-v1",
        evaluatedAt: new Date("2026-07-01T00:00:00.000Z"),
        expiresAt: new Date("2026-07-10T00:00:00.000Z"),
      },
    });
    await prisma.chatExchangeFact.create({
      data: {
        id: `exchange-fact-${suffix}`,
        exchangeId: `exchange-${suffix}`,
        sourceService: "chat",
        sourceEventId: `exchange-event-${suffix}`,
        userMessageId: `user-message-${suffix}`,
        assistantMessageId: `assistant-message-${suffix}`,
        selectedAssistantMessageId: `assistant-message-${suffix}`,
        assistantAttemptNo: 1,
        sessionId: `session-${suffix}`,
        engagementSessionId: `engagement-${suffix}`,
        userId: `user-${suffix}`,
        characterId,
        characterContentVersionId: contentId,
        characterReleaseId: releaseId,
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actorIsInternal: false,
        eligible: true,
        occurredAt: new Date("2026-07-08T00:00:00.000Z"),
        productDay: new Date("2026-07-08T00:00:00.000Z"),
        sourceUpdatedAt: new Date("2026-07-08T00:00:00.000Z"),
        validFrom: new Date("2026-07-08T00:00:00.000Z"),
      },
    });
  });

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: releaseId } });
    await prisma.characterReleaseEvent.deleteMany({ where: { releaseId } });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId } });
    await prisma.chatExchangeFact.deleteMany({ where: { characterReleaseId: releaseId } });
    await prisma.characterServing.delete({ where: { characterId } });
    await prisma.generationRouteQualification.delete({ where: { id: qualificationId } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.$disconnect();
  });

  it("derives staleness without rewriting historical qualification or taking serving offline", async () => {
    expect(evaluateRouteQualification({
      qualification: {
        result: "qualified",
        sampleCount: 40,
        identityMatch: 0.95,
        policyVersion: "policy-v1",
        expiresAt: new Date("2026-07-10T00:00:00.000Z"),
        evidence: { evaluatorVersion: "eval-v1" },
      },
      currentPolicyVersion: "policy-v1",
      currentEvaluatorVersion: "eval-v1",
      now,
    })).toEqual({ state: "expired", reason: "qualification_expired" });

    expect(await dispatchStaleReleaseRoutes(prisma, {
      currentPolicyVersion: "policy-v1",
      currentEvaluatorVersion: "eval-v1",
      now,
      releaseIds: [releaseId],
    })).toMatchObject({ stale: 1 });
    expect(await prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } })).toMatchObject({
      readiness: "stale",
      status: "published",
    });
    expect(await prisma.characterServing.findUniqueOrThrow({ where: { characterId } })).toMatchObject({
      state: "live",
      currentReleaseId: releaseId,
    });
    expect(await prisma.generationRouteQualification.findUniqueOrThrow({ where: { id: qualificationId } })).toMatchObject({
      result: "qualified",
    });
  });

  it("collects mature 72h facts with an explicit keep decision", async () => {
    const result = await collectReleaseMonitorFacts(prisma, { releaseId, window: "72h", now });
    expect(result).toMatchObject({
      mature: true,
      recommendation: "keep",
      observed: { exchangeCount: 1, uniqueUsers: 1, engagementSessions: 1 },
    });
    expect(result.monitor).toMatchObject({ status: "completed", window: "72h" });
  });
});
