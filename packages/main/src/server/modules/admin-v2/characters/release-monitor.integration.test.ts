import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePermissions } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import { buildTodayProjection } from "@/server/modules/admin-v2/today/query";
import {
  collectReleaseMonitorFacts,
  dispatchDueReleaseMonitors,
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
  const ownerId = `monitor-owner-${suffix}`;
  const assetId = `monitor-avatar-${suffix}`;
  const publishedAt = new Date("2026-07-07T00:00:00.000Z");
  const now = new Date("2026-07-11T00:00:00.000Z");

  beforeAll(async () => {
    await prisma.user.create({ data: { id: ownerId, email: `${ownerId}@example.test`, role: "admin" } });
    await prisma.mediaAsset.create({ data: {
      id: assetId,
      ownerId,
      type: "image",
      url: `/user-content/${assetId}/content.webp`,
      visibility: "unlisted",
      safetyStatus: "passed",
      metadata: {},
    } });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Release monitor character",
        age: 24,
        description: "Fixture for release monitoring.",
        source: "official",
        status: "approved",
        visibility: "public",
        imageAssetId: assetId,
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: { id: projectId, characterId, phase: "live_management", audience: {}, successCriteria: [] },
    });
    await prisma.characterContentVersion.create({ data: {
      id: contentId,
      characterId,
      version: 1,
      contentHash: `monitor-content-hash-${suffix}`,
      personaSnapshot: { name: "Release monitor character" },
      openingSnapshot: { firstMessage: "Hello" },
      appearanceSnapshot: {},
      sourceType: "test",
    } });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `revision-${suffix}`,
        characterContentVersionId: contentId,
        generationProvenance: { routeFingerprint: `route-${suffix}` },
        releasePlacementManifest: { placements: [{ slotKey: "character_avatar", assetId, slotVersion: 1 }] },
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
    await prisma.adminAuditLog.deleteMany({ where: { targetType: "release_monitor", targetId: { startsWith: releaseId } } });
    await prisma.characterReleaseEvent.deleteMany({ where: { releaseId } });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId } });
    await prisma.chatExchangeFact.deleteMany({ where: { characterReleaseId: releaseId } });
    await prisma.characterServing.delete({ where: { characterId } });
    await prisma.generationRouteQualification.delete({ where: { id: qualificationId } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterContentVersion.delete({ where: { id: contentId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.character.delete({ where: { id: characterId } });
    await prisma.mediaAsset.delete({ where: { id: assetId } });
    await prisma.user.delete({ where: { id: ownerId } });
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
    await prisma.characterRelease.update({ where: { id: releaseId }, data: { readiness: "ready" } });
    const result = await collectReleaseMonitorFacts(prisma, { releaseId, window: "72h", now });
    expect(result).toMatchObject({
      mature: true,
      recommendation: "keep",
      observed: {
        exchangeCount: 1,
        uniqueUsers: 1,
        engagementSessions: 1,
        operationalChecks: {
          servingPointerLive: true,
          publicProjectionLive: true,
          immutableContentAvailable: true,
          releaseAvatarRenderable: true,
          chatAuthorityReady: true,
        },
      },
    });
    expect(result.monitor).toMatchObject({ status: "completed", window: "72h" });
  });

  it("opens action-required work when the actual serving pointer is unavailable", async () => {
    await prisma.characterServing.update({ where: { characterId }, data: { state: "paused" } });
    const result = await collectReleaseMonitorFacts(prisma, { releaseId, window: "24h", now });
    expect(result).toMatchObject({
      mature: true,
      recommendation: "rollback_review",
      observed: { operationalChecks: { servingPointerLive: false, chatAuthorityReady: false } },
      monitor: { status: "action_required" },
    });
  });

  it("dispatches each due window once across competing workers and re-enters Today on 72h failure", async () => {
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "ready", status: "published" },
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", currentReleaseId: releaseId },
    });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId, window: { in: ["24h", "72h"] } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetType: "release_monitor", targetId: { startsWith: releaseId } } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: releaseId, eventType: "character.release.monitor_evaluated.v2" },
    });
    await prisma.releaseMonitor.createMany({
      data: (["24h", "72h"] as const).map((window) => ({
        id: `${releaseId}:${window}`,
        releaseId,
        window,
        status: "pending",
        baseline: {},
        observed: {},
        verification: { state: "pending" },
        startedAt: publishedAt,
        dueAt: new Date(publishedAt.getTime() + (window === "24h" ? 24 : 72) * 60 * 60 * 1_000),
      })),
    });

    const at24h = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1_000);
    const [left, right] = await Promise.all([
      dispatchDueReleaseMonitors(prisma, { workerId: "monitor-worker-left", now: at24h }),
      dispatchDueReleaseMonitors(prisma, { workerId: "monitor-worker-right", now: at24h }),
    ]);
    expect(left.evaluated + right.evaluated, JSON.stringify({ left, right })).toBe(1);
    await expect(prisma.releaseMonitor.findUniqueOrThrow({
      where: { releaseId_window: { releaseId, window: "24h" } },
    })).resolves.toMatchObject({ status: "completed", leaseOwner: null, leaseExpiresAt: null });
    await expect(prisma.releaseMonitor.findUniqueOrThrow({
      where: { releaseId_window: { releaseId, window: "72h" } },
    })).resolves.toMatchObject({ status: "pending" });

    await dispatchDueReleaseMonitors(prisma, { workerId: "monitor-restart", now: at24h });
    await expect(prisma.adminAuditLog.count({
      where: { action: "character.release.monitor.evaluated", targetId: `${releaseId}:24h` },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: releaseId, eventType: "character.release.monitor_evaluated.v2" },
    })).resolves.toBe(1);

    await prisma.characterRelease.update({ where: { id: releaseId }, data: { readiness: "stale" } });
    const at72h = new Date(publishedAt.getTime() + 72 * 60 * 60 * 1_000);
    await dispatchDueReleaseMonitors(prisma, { workerId: "monitor-worker-72h", now: at72h });
    await expect(prisma.releaseMonitor.findUniqueOrThrow({
      where: { releaseId_window: { releaseId, window: "72h" } },
    })).resolves.toMatchObject({ status: "action_required" });

    const today = await buildTodayProjection({
      actor: { id: ownerId, role: "admin" },
      permissions: resolvePermissions("admin"),
      now: at72h,
      workMode: "character_producer",
    });
    expect(today.nextBestActions.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "character_release",
        sourceId: releaseId,
        verificationState: "failed",
      }),
    ]));
    await expect(prisma.adminAuditLog.count({
      where: { action: "character.release.monitor.evaluated", targetId: { startsWith: `${releaseId}:` } },
    })).resolves.toBe(2);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: releaseId, eventType: "character.release.monitor_evaluated.v2" },
    })).resolves.toBe(2);
  });

  it("reclaims an expired lease after worker restart without replaying evidence", async () => {
    const monitorId = `${releaseId}:24h`;
    const dueAt = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1_000);
    const restartedAt = new Date(dueAt.getTime() + 10 * 60 * 1_000);
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "ready", status: "published" },
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", currentReleaseId: releaseId },
    });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: monitorId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: releaseId, eventType: "character.release.monitor_evaluated.v2" },
    });
    await prisma.releaseMonitor.upsert({
      where: { releaseId_window: { releaseId, window: "24h" } },
      create: {
        id: monitorId,
        releaseId,
        window: "24h",
        status: "pending",
        baseline: {},
        observed: {},
        verification: { state: "pending" },
        startedAt: publishedAt,
        dueAt,
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(dueAt.getTime() - 1),
      },
      update: {
        status: "pending",
        baseline: {},
        observed: {},
        verification: { state: "pending" },
        finishedAt: null,
        dueAt,
        leaseOwner: "dead-worker",
        leaseExpiresAt: new Date(dueAt.getTime() - 1),
        nextAttemptAt: null,
        attemptCount: 0,
      },
    });

    await expect(dispatchDueReleaseMonitors(prisma, {
      workerId: "replacement-worker",
      now: restartedAt,
    })).resolves.toMatchObject({ claimed: 1, evaluated: 1, completed: 1, failed: 0 });
    await expect(prisma.releaseMonitor.findUniqueOrThrow({ where: { id: monitorId } })).resolves.toMatchObject({
      status: "completed",
      attemptCount: 1,
      leaseOwner: null,
    });

    await expect(dispatchDueReleaseMonitors(prisma, {
      workerId: "second-restart",
      now: restartedAt,
    })).resolves.toMatchObject({ claimed: 0, evaluated: 0 });
    await expect(prisma.adminAuditLog.count({ where: { targetId: monitorId } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: releaseId, eventType: "character.release.monitor_evaluated.v2" },
    })).resolves.toBe(1);
  });

  it("closes a due monitor as superseded when its Release is no longer serving", async () => {
    const monitorId = `${releaseId}:24h`;
    const dueAt = new Date(publishedAt.getTime() + 24 * 60 * 60 * 1_000);
    await prisma.adminAuditLog.deleteMany({ where: { targetId: monitorId } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: releaseId, eventType: "character.release.monitor_evaluated.v2" },
    });
    await prisma.characterServing.update({ where: { characterId }, data: { currentReleaseId: null } });
    await prisma.characterRelease.update({ where: { id: releaseId }, data: { status: "superseded" } });
    await prisma.releaseMonitor.update({
      where: { releaseId_window: { releaseId, window: "24h" } },
      data: {
        status: "pending",
        baseline: {},
        observed: {},
        verification: { state: "pending" },
        finishedAt: null,
        dueAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        attemptCount: 0,
      },
    });

    await expect(dispatchDueReleaseMonitors(prisma, {
      workerId: "superseded-worker",
      now: dueAt,
    })).resolves.toMatchObject({ evaluated: 1, superseded: 1, failed: 0 });
    await expect(prisma.releaseMonitor.findUniqueOrThrow({ where: { id: monitorId } })).resolves.toMatchObject({
      status: "superseded",
      verification: { state: "superseded", recommendation: "no_longer_serving" },
    });
    await expect(prisma.adminAuditLog.count({ where: { targetId: monitorId } })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: { aggregateId: releaseId, eventType: "character.release.monitor_evaluated.v2" },
    })).resolves.toBe(1);

    const today = await buildTodayProjection({
      actor: { id: ownerId, role: "admin" },
      permissions: resolvePermissions("admin"),
      now: dueAt,
      workMode: "character_producer",
    });
    expect(today.nextBestActions.items.some((item) => item.sourceId === releaseId)).toBe(false);
  });
});
