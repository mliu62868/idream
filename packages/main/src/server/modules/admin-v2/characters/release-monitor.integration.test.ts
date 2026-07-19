import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePermissions } from "@/server/admin/permissions";
import { drainAdminCommands } from "@/processes/admin-command-worker";
import { prisma } from "@/server/lib/db";
import { buildTodayProjection } from "@/server/modules/admin-v2/today/query";
import {
  CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
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
  const editorialReleaseId = `monitor-editorial-release-${suffix}`;
  const editorialSnapshotHash = `monitor-editorial-snapshot-${suffix}`;
  const contentId = `monitor-content-${suffix}`;
  const qualificationId = `monitor-qualification-${suffix}`;
  const ownerId = `monitor-owner-${suffix}`;
  const assetId = `monitor-avatar-${suffix}`;
  const heroAssetId = `monitor-hero-${suffix}`;
  const chatAssetId = `monitor-chat-${suffix}`;
  const routeFingerprint = `route-${suffix}`;
  const publishedAt = new Date("2026-07-07T00:00:00.000Z");
  const now = new Date("2026-07-11T00:00:00.000Z");

  function releaseGenerationProvenance(
    providers: Partial<Record<
      "character_avatar" | "character_hero" | "character_chat",
      string
    >> = {},
  ) {
    return {
      routeFingerprint,
      placements: [
        {
          slotKey: "character_avatar",
          assetId,
          provider: providers.character_avatar ?? "comfyui",
        },
        {
          slotKey: "character_hero",
          assetId: heroAssetId,
          provider: providers.character_hero ?? "comfyui",
        },
        {
          slotKey: "character_chat",
          assetId: chatAssetId,
          provider: providers.character_chat ?? "comfyui",
        },
      ],
    };
  }

  beforeAll(async () => {
    await prisma.user.create({ data: { id: ownerId, email: `${ownerId}@example.test`, role: "admin" } });
    await prisma.mediaAsset.createMany({ data: [assetId, heroAssetId, chatAssetId].map((id) => ({
      id,
      ownerId,
      type: "image",
      url: `/user-content/${id}/content.webp`,
      visibility: "public_pack",
      safetyStatus: "passed",
      metadata: {},
    })) });
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
    await prisma.mediaAsset.updateMany({
      where: { id: { in: [assetId, heroAssetId, chatAssetId] } },
      data: { characterId },
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
        generationProvenance: releaseGenerationProvenance(),
        releasePlacementManifest: {
          schemaVersion: 2,
          placements: [
            {
              slotKey: "character_avatar",
              assetId,
              slotVersion: 1,
              runId: `monitor-avatar-run-${suffix}`,
              itemId: `monitor-avatar-item-${suffix}`,
              reviewDecisionId: `monitor-avatar-decision-${suffix}`,
              generationJobId: `monitor-avatar-job-${suffix}`,
            },
            {
              slotKey: "character_hero",
              assetId: heroAssetId,
              slotVersion: 1,
              runId: `monitor-hero-run-${suffix}`,
              itemId: `monitor-hero-item-${suffix}`,
              reviewDecisionId: `monitor-hero-decision-${suffix}`,
              generationJobId: `monitor-hero-job-${suffix}`,
            },
            {
              slotKey: "character_chat",
              assetId: chatAssetId,
              slotVersion: 1,
              runId: `monitor-chat-run-${suffix}`,
              itemId: `monitor-chat-item-${suffix}`,
              reviewDecisionId: `monitor-chat-decision-${suffix}`,
              generationJobId: `monitor-chat-job-${suffix}`,
            },
          ],
        },
        snapshotHash: `snapshot-${suffix}`,
        readiness: "ready",
        status: "published",
        publishedAt,
        version: 3,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: editorialReleaseId,
        projectId,
        revisionId: `editorial-revision-${suffix}`,
        characterContentVersionId: contentId,
        generationProvenance: {
          schemaVersion: "character-release-editorial-import-v1",
          dataset: "seed-characters.json",
          recordId: characterId,
          sourceAssetId: assetId,
        },
        releasePlacementManifest: {
          schemaVersion: 1,
          kind: "editorial_import",
          placements: [{
            slotKey: "character_avatar",
            assetId,
            slotVersion: 1,
          }],
        },
        snapshotHash: editorialSnapshotHash,
        readiness: "ready",
        legacy: true,
        status: "published",
        publishedAt,
      },
    });
    await prisma.publicCatalogQualification.create({
      data: {
        id: `monitor-editorial-qualification-${suffix}`,
        releaseId: editorialReleaseId,
        releaseSnapshotHash: editorialSnapshotHash,
        kind: "editorial_import",
        evidence: {
          schemaVersion: "public-catalog-qualification-v1",
          policyVersion: "public-catalog-editorial-import-v1",
          checks: {
            exactSeedRecord: true,
            nonSynthetic: true,
            safetyPassed: true,
            publicPack: true,
            imageAvailable: true,
          },
        },
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
        routeFingerprint,
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
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId: { in: [editorialReleaseId, releaseId] } },
    });
    await prisma.characterRelease.delete({ where: { id: editorialReleaseId } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterContentVersion.delete({ where: { id: contentId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.character.delete({ where: { id: characterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [assetId, heroAssetId, chatAssetId] } } });
    await prisma.user.delete({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  it("does not apply generation-route authority to a qualified editorial import", async () => {
    await expect(dispatchStaleReleaseRoutes(prisma, {
      currentPolicyVersion: "policy-v2",
      currentEvaluatorVersion: "eval-v2",
      now,
      releaseIds: [editorialReleaseId],
    })).resolves.toEqual({
      examined: 0,
      stale: 0,
      nextCursor: null,
    });
    await expect(prisma.characterRelease.findUniqueOrThrow({
      where: { id: editorialReleaseId },
    })).resolves.toMatchObject({
      readiness: "ready",
      legacy: true,
      status: "published",
    });
    await expect(prisma.releaseMonitor.count({
      where: {
        releaseId: editorialReleaseId,
        window: "route_qualification",
      },
    })).resolves.toBe(0);
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
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ visibility: "unlisted", status: "approved" });
    await expect(prisma.mainOutboxEvent.findFirstOrThrow({
      where: {
        aggregateId: releaseId,
        eventType: "character.release.qualification_stale.v2",
      },
    })).resolves.toMatchObject({
      status: "delivered",
      deliveredAt: now,
    });
  });

  it("runs qualification invalidation from the persistent command worker", async () => {
    await prisma.character.update({
      where: { id: characterId },
      data: { visibility: "public" },
    });
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "ready" },
    });

    const result = await drainAdminCommands(prisma, {
      workerId: `qualification-worker-${suffix}`,
      now: new Date("2026-07-07T01:00:00.000Z"),
      routeQualificationPolicyVersion: "policy-v2",
      routeQualificationEvaluatorVersion: "eval-v1",
      routeQualificationReleaseIds: [releaseId],
    });

    expect(result.routeQualifications).toMatchObject({ examined: 1, stale: 1 });
    await expect(
      prisma.characterRelease.findUniqueOrThrow({ where: { id: releaseId } }),
    ).resolves.toMatchObject({ readiness: "stale", status: "published" });
  });

  it("collects mature 72h facts with an explicit keep decision", async () => {
    await prisma.character.update({
      where: { id: characterId },
      data: { visibility: "public" },
    });
    await prisma.characterRelease.update({ where: { id: releaseId }, data: { readiness: "ready" } });
    const result = await collectReleaseMonitorFacts(prisma, { releaseId, window: "72h", now });
    expect(result).toMatchObject({
      mature: true,
      recommendation: "keep",
      observed: {
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
        exchangeCount: 1,
        uniqueUsers: 1,
        engagementSessions: 1,
        operationalChecks: {
          servingPointerLive: true,
          publicProjectionLive: true,
          immutableContentAvailable: true,
          releaseAvatarRenderable: true,
          releaseAvatarVisible: true,
          releaseHeroRenderable: true,
          releaseHeroVisible: true,
          releaseChatRenderable: true,
          releaseChatVisible: true,
          chatAuthorityReady: true,
        },
      },
    });
    expect(result.monitor).toMatchObject({
      status: "completed",
      window: "72h",
      verification: {
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
      },
    });
  });

  it("fails closed when a strict Release hero or chat asset stops serving", async () => {
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "ready", status: "published" },
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", currentReleaseId: releaseId },
    });

    await prisma.mediaAsset.update({
      where: { id: heroAssetId },
      data: { visibility: "unlisted" },
    });
    await expect(
      collectReleaseMonitorFacts(prisma, { releaseId, window: "24h", now }),
    ).resolves.toMatchObject({
      recommendation: "rollback_review",
      observed: {
        operationalChecks: {
          releaseHeroRenderable: true,
          releaseHeroVisible: false,
        },
      },
      monitor: { status: "action_required" },
    });
    await prisma.mediaAsset.update({
      where: { id: heroAssetId },
      data: { visibility: "public_pack" },
    });

    await prisma.mediaAsset.update({
      where: { id: chatAssetId },
      data: { deletedAt: now },
    });
    await expect(
      collectReleaseMonitorFacts(prisma, { releaseId, window: "24h", now }),
    ).resolves.toMatchObject({
      recommendation: "rollback_review",
      observed: {
        operationalChecks: {
          releaseChatRenderable: false,
          chatAuthorityReady: false,
        },
      },
      monitor: { status: "action_required" },
    });
    await prisma.mediaAsset.update({
      where: { id: chatAssetId },
      data: { deletedAt: null },
    });
  });

  it("uses immutable generation providers to fail closed for mock avatar, hero, and chat slots", async () => {
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: {
        generationProvenance: releaseGenerationProvenance({
          character_avatar: "mock",
          character_hero: "mock-image",
          character_chat: "mocked-provider",
        }),
      },
    });
    try {
      const result = await collectReleaseMonitorFacts(prisma, {
        releaseId,
        window: "72h",
        now,
      });
      expect(result).toMatchObject({
        recommendation: "rollback_review",
        observed: {
          releaseAssetSlots: {
            character_avatar: {
              provider: "mock",
              metadataSynthetic: false,
              metadataSyntheticMarkerInvalid: false,
              mockProvider: true,
              synthetic: true,
              syntheticReasons: ["pinned_provider_mock"],
              customerReadable: false,
            },
            character_hero: {
              provider: "mock-image",
              metadataSynthetic: false,
              metadataSyntheticMarkerInvalid: false,
              mockProvider: true,
              synthetic: true,
              syntheticReasons: ["pinned_provider_mock"],
              customerReadable: false,
            },
            character_chat: {
              provider: "mocked-provider",
              metadataSynthetic: false,
              metadataSyntheticMarkerInvalid: false,
              mockProvider: true,
              synthetic: true,
              syntheticReasons: ["pinned_provider_mock"],
              customerReadable: false,
            },
          },
          operationalChecks: {
            releaseAvatarRenderable: true,
            releaseAvatarVisible: false,
            releaseHeroRenderable: true,
            releaseHeroVisible: false,
            releaseChatRenderable: true,
            releaseChatVisible: false,
            chatAuthorityReady: false,
          },
        },
        monitor: { status: "action_required" },
      });
    } finally {
      await prisma.characterRelease.update({
        where: { id: releaseId },
        data: { generationProvenance: releaseGenerationProvenance() },
      });
    }
  });

  it("fails closed when strict v2 provider evidence is missing or duplicated", async () => {
    const valid = releaseGenerationProvenance();
    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: {
        generationProvenance: {
          ...valid,
          placements: [
            valid.placements[0],
            valid.placements[1],
            valid.placements[1],
          ],
        },
      },
    });
    try {
      await expect(
        collectReleaseMonitorFacts(prisma, {
          releaseId,
          window: "72h",
          now,
        }),
      ).resolves.toMatchObject({
        recommendation: "rollback_review",
        observed: {
          releaseAssetSlots: {
            character_hero: {
              provider: null,
              providerMissing: true,
              providerDuplicate: true,
              syntheticReasons: [
                "pinned_provider_missing",
                "pinned_provider_duplicate",
              ],
              customerReadable: false,
            },
            character_chat: {
              provider: null,
              providerMissing: true,
              providerDuplicate: false,
              syntheticReasons: ["pinned_provider_missing"],
              customerReadable: false,
            },
          },
          operationalChecks: {
            releaseHeroVisible: false,
            releaseChatVisible: false,
            chatAuthorityReady: false,
          },
        },
        monitor: { status: "action_required" },
      });
    } finally {
      await prisma.characterRelease.update({
        where: { id: releaseId },
        data: { generationProvenance: releaseGenerationProvenance() },
      });
    }
  });

  it("keeps metadata-only synthetic assets customer-unreadable", async () => {
    await prisma.mediaAsset.update({
      where: { id: heroAssetId },
      data: {
        metadata: {
          synthetic: true,
          source: "mock",
        },
      },
    });
    try {
      await expect(
        collectReleaseMonitorFacts(prisma, {
          releaseId,
          window: "72h",
          now,
        }),
      ).resolves.toMatchObject({
        recommendation: "rollback_review",
        observed: {
          releaseAssetSlots: {
            character_hero: {
              provider: "comfyui",
              metadataSynthetic: true,
              metadataSyntheticMarkerInvalid: false,
              mockProvider: false,
              synthetic: true,
              syntheticReasons: ["metadata_synthetic"],
              customerReadable: false,
            },
          },
          operationalChecks: {
            releaseHeroRenderable: true,
            releaseHeroVisible: false,
          },
        },
        monitor: { status: "action_required" },
      });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: heroAssetId },
        data: { metadata: {} },
      });
    }
  });

  it("fails closed for malformed synthetic metadata markers", async () => {
    await prisma.mediaAsset.update({
      where: { id: heroAssetId },
      data: {
        metadata: {
          synthetic: "unknown",
        },
      },
    });
    try {
      await expect(
        collectReleaseMonitorFacts(prisma, {
          releaseId,
          window: "72h",
          now,
        }),
      ).resolves.toMatchObject({
        recommendation: "rollback_review",
        observed: {
          releaseAssetSlots: {
            character_hero: {
              provider: "comfyui",
              metadataSynthetic: false,
              metadataSyntheticMarkerInvalid: true,
              mockProvider: false,
              synthetic: true,
              syntheticReasons: ["metadata_synthetic_marker_invalid"],
              customerReadable: false,
            },
          },
          operationalChecks: {
            releaseHeroRenderable: true,
            releaseHeroVisible: false,
          },
        },
        monitor: { status: "action_required" },
      });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: heroAssetId },
        data: { metadata: {} },
      });
    }
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

  it("requeues old and missing completed monitor policies once and emits versioned evidence", async () => {
    const monitor24hId = `${releaseId}:24h`;
    const monitor72hId = `${releaseId}:72h`;
    const oldPolicyVersion = "character-release-monitor-policy-v0";
    const oldOccurrenceKey =
      `release-monitor:${releaseId}:24h:${monitor24hId}:${oldPolicyVersion}`;
    const current24hOccurrenceKey =
      `release-monitor:${releaseId}:24h:${monitor24hId}:${CHARACTER_RELEASE_MONITOR_POLICY_VERSION}`;
    const current72hOccurrenceKey =
      `release-monitor:${releaseId}:72h:${monitor72hId}:${CHARACTER_RELEASE_MONITOR_POLICY_VERSION}`;

    await prisma.characterRelease.update({
      where: { id: releaseId },
      data: { readiness: "ready", status: "published" },
    });
    await prisma.characterServing.update({
      where: { characterId },
      data: { state: "live", currentReleaseId: releaseId },
    });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId } });
    await prisma.adminAuditLog.deleteMany({
      where: { targetType: "release_monitor", targetId: { startsWith: releaseId } },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        aggregateId: releaseId,
        eventType: "character.release.monitor_evaluated.v2",
      },
    });
    await prisma.releaseMonitor.createMany({
      data: [
        {
          id: monitor24hId,
          releaseId,
          window: "24h",
          status: "completed",
          baseline: {},
          observed: {},
          verification: {
            policyVersion: oldPolicyVersion,
            maturity: "mature",
            recommendation: "keep",
          },
          startedAt: publishedAt,
          dueAt: new Date(publishedAt.getTime() + 24 * 60 * 60 * 1_000),
          finishedAt: now,
        },
        {
          id: monitor72hId,
          releaseId,
          window: "72h",
          status: "completed",
          baseline: {},
          observed: {},
          verification: {
            maturity: "mature",
            recommendation: "keep",
          },
          startedAt: publishedAt,
          dueAt: new Date(publishedAt.getTime() + 72 * 60 * 60 * 1_000),
          finishedAt: now,
        },
      ],
    });
    await prisma.adminAuditLog.create({
      data: {
        id: `audit:${oldOccurrenceKey}`,
        actorId: "system:release-monitor-dispatcher",
        actorRole: "system",
        action: "character.release.monitor.evaluated",
        targetType: "release_monitor",
        targetId: monitor24hId,
        reason: "Legacy policy evidence",
        after: { occurrenceKey: oldOccurrenceKey, policyVersion: oldPolicyVersion },
        requestId: oldOccurrenceKey,
        createdAt: publishedAt,
      },
    });
    await prisma.mainOutboxEvent.create({
      data: {
        id: `outbox:${oldOccurrenceKey}`,
        eventType: "character.release.monitor_evaluated.v2",
        aggregateType: "character_release",
        aggregateId: releaseId,
        payload: { occurrenceKey: oldOccurrenceKey, policyVersion: oldPolicyVersion },
        nextRunAt: publishedAt,
        createdAt: publishedAt,
      },
    });

    await expect(dispatchDueReleaseMonitors(prisma, {
      workerId: "monitor-policy-upgrade",
      now,
    })).resolves.toMatchObject({
      requeued: 2,
      claimed: 2,
      evaluated: 2,
      completed: 2,
      failed: 0,
    });
    const rescanned = await prisma.releaseMonitor.findMany({
      where: { releaseId },
      orderBy: { window: "asc" },
    });
    expect(rescanned).toHaveLength(2);
    expect(rescanned).toEqual([
      expect.objectContaining({
        id: monitor24hId,
        status: "completed",
        attemptCount: 1,
        verification: expect.objectContaining({
          policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
        }),
      }),
      expect.objectContaining({
        id: monitor72hId,
        status: "completed",
        attemptCount: 1,
        verification: expect.objectContaining({
          policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
        }),
      }),
    ]);
    await expect(prisma.adminAuditLog.findUnique({
      where: { id: `audit:${current24hOccurrenceKey}` },
    })).resolves.toMatchObject({
      requestId: current24hOccurrenceKey,
      after: {
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
      },
    });
    await expect(prisma.adminAuditLog.findUnique({
      where: { id: `audit:${current72hOccurrenceKey}` },
    })).resolves.toMatchObject({
      requestId: current72hOccurrenceKey,
      after: {
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
      },
    });
    await expect(prisma.mainOutboxEvent.findUnique({
      where: { id: `outbox:${current24hOccurrenceKey}` },
    })).resolves.toMatchObject({
      payload: {
        occurrenceKey: current24hOccurrenceKey,
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
      },
    });
    await expect(prisma.mainOutboxEvent.findUnique({
      where: { id: `outbox:${current72hOccurrenceKey}` },
    })).resolves.toMatchObject({
      payload: {
        occurrenceKey: current72hOccurrenceKey,
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
      },
    });
    await expect(prisma.adminAuditLog.count({
      where: {
        action: "character.release.monitor.evaluated",
        targetId: { startsWith: releaseId },
      },
    })).resolves.toBe(3);
    await expect(prisma.mainOutboxEvent.count({
      where: {
        aggregateId: releaseId,
        eventType: "character.release.monitor_evaluated.v2",
      },
    })).resolves.toBe(3);

    await expect(dispatchDueReleaseMonitors(prisma, {
      workerId: "monitor-policy-upgrade-repeat",
      now,
    })).resolves.toMatchObject({
      requeued: 0,
      claimed: 0,
      evaluated: 0,
    });
    await expect(prisma.adminAuditLog.count({
      where: {
        action: "character.release.monitor.evaluated",
        targetId: { startsWith: releaseId },
      },
    })).resolves.toBe(3);
    await expect(prisma.mainOutboxEvent.count({
      where: {
        aggregateId: releaseId,
        eventType: "character.release.monitor_evaluated.v2",
      },
    })).resolves.toBe(3);
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
