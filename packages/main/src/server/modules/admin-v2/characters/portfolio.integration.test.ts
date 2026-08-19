import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterPortfolioQuerySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { createUser } from "@/server/test/helpers";
import { toInputJson } from "../shared/prisma-json";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import {
  createCharacterPortfolioDecision,
  listCharacterPortfolio,
  listCharacterPortfolioData,
} from "./portfolio";

describe("Character Portfolio authority/read model", () => {
  const suffix = randomUUID();
  const adminId = `portfolio-admin-${suffix}`;
  const analystId = `portfolio-analyst-${suffix}`;
  const producerId = `portfolio-producer-${suffix}`;
  const scopedViewerId = `portfolio-scoped-viewer-${suffix}`;
  const globalCreativeViewerId = `portfolio-global-creative-viewer-${suffix}`;
  const unscopedProducerViewerId = `portfolio-unscoped-producer-viewer-${suffix}`;
  const characterA = `portfolio-character-a-${suffix}`;
  const characterB = `portfolio-character-b-${suffix}`;
  const projectA = `portfolio-project-a-${suffix}`;
  const projectB = `portfolio-project-b-${suffix}`;
  const contentA = `portfolio-content-a-${suffix}`;
  const contentB = `portfolio-content-b-${suffix}`;
  const releaseA = `portfolio-release-a-${suffix}`;
  const releaseB = `portfolio-release-b-${suffix}`;
  const visualProfileId = `portfolio-visual-${suffix}`;
  const visualProfileBId = `portfolio-visual-b-${suffix}`;
  const referenceSetId = `portfolio-reference-set-${suffix}`;
  const referenceSetBId = `portfolio-reference-set-b-${suffix}`;
  const generationProfileId = `portfolio-generation-profile-${suffix}`;
  const generationProfileKey = `portfolio-generation-${suffix}`;
  const qualificationId = `portfolio-qualification-${suffix}`;
  const routeFingerprint = `portfolio-route-${suffix}`;
  const staleRouteFingerprint = `portfolio-route-stale-${suffix}`;
  const routeStyle = `portfolio-style-${suffix}`;
  const draftCoverAssetId = `portfolio-draft-cover-${suffix}`;
  const draftHeroAssetId = `portfolio-draft-hero-${suffix}`;
  const draftChatAssetId = `portfolio-draft-chat-${suffix}`;
  const liveCoverAssetId = `portfolio-live-cover-${suffix}`;
  const liveHeroAssetId = `portfolio-live-hero-${suffix}`;
  const characterBAnchorAssetId = `portfolio-b-anchor-${suffix}`;
  const mediaAssetIds = [
    draftCoverAssetId,
    draftHeroAssetId,
    draftChatAssetId,
    liveCoverAssetId,
    liveHeroAssetId,
    characterBAnchorAssetId,
  ];
  const asOf = new Date("2026-07-11T00:00:00.000Z");

  beforeAll(async () => {
    await createUser({ id: adminId, role: "admin", dataClass: "internal" });
    await createUser({ id: analystId, role: "analyst", dataClass: "internal" });
    await createUser({ id: producerId, role: "user", dataClass: "internal" });
    await createUser({ id: scopedViewerId, role: "user", dataClass: "internal" });
    await createUser({ id: globalCreativeViewerId, role: "analyst", dataClass: "internal" });
    await createUser({ id: unscopedProducerViewerId, role: "user", dataClass: "internal" });
    await prisma.character.createMany({
      data: [
        {
          id: characterA,
          name: "Astra Portfolio",
          age: 24,
          description: "high relationship value",
          visibility: "public",
          status: "approved",
          source: "official",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: characterB,
          name: "Beta Portfolio",
          age: 25,
          description: "pagination fixture",
          visibility: "public",
          status: "approved",
          source: "official",
          appearance: {},
          advancedDetails: {},
        },
      ],
    });
    await prisma.mediaAsset.createMany({
      data: mediaAssetIds.map((id) => ({
        id,
        ownerId: producerId,
        characterId: id === characterBAnchorAssetId ? characterB : characterA,
        type: "image",
        url: `/media/${id}`,
        storageKey: `portfolio/${suffix}/${id}.webp`,
        visibility: "unlisted",
        safetyStatus: "passed",
        metadata: {},
      })),
    });
    await prisma.character.update({
      where: { id: characterA },
      data: { imageAssetId: liveCoverAssetId },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId: characterA,
        status: "active",
        style: routeStyle,
        identityPrompt: "Astra's stable adult identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [draftCoverAssetId],
        adapterRefs: {},
        evidenceState: "reviewed",
        createdFrom: "portfolio_test",
      },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "portfolio-v1",
        createdFrom: "portfolio_test",
        references: {
          create: {
            mediaAssetId: draftCoverAssetId,
            position: 0,
            role: "identity_anchor",
            selectionReason: "portfolio fixture",
          },
        },
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileBId,
        characterId: characterB,
        status: "active",
        style: routeStyle,
        identityPrompt: "Beta's stable adult identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [characterBAnchorAssetId],
        adapterRefs: {},
        evidenceState: "reviewed",
        createdFrom: "portfolio_test",
      },
    });
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetBId,
        visualProfileId: visualProfileBId,
        revision: 1,
        status: "active",
        selectorVersion: "portfolio-v1",
        createdFrom: "portfolio_test",
        references: {
          create: {
            mediaAssetId: characterBAnchorAssetId,
            position: 0,
            role: "identity_anchor",
            selectionReason: "portfolio repeated-route fixture",
          },
        },
      },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: generationProfileId,
        profileKey: generationProfileKey,
        label: "Portfolio identity route",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-img2img",
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        status: "active",
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: qualificationId,
        routeFingerprint,
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: routeStyle,
        matrixKey: `portfolio-matrix-${suffix}`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.95,
        result: "qualified",
        evidence: {
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      },
    });
    await prisma.characterContentVersion.createMany({
      data: [
        { id: contentA, characterId: characterA, version: 1, contentHash: `hash-a-${suffix}`, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" },
        { id: contentB, characterId: characterB, version: 1, contentHash: `hash-b-${suffix}`, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" },
      ],
    });
    await prisma.characterProject.createMany({
      data: [
        {
          id: projectA,
          characterId: characterA,
          ownerId: producerId,
          phase: "live_management",
          audience: {
            label: "returning companion users",
            companionNeed: "continuity",
            targetPlacementKeys: ["feed.hero"],
          },
          hypothesis: "continuity increases D7",
          differentiation: "memory",
          successCriteria: ["D7 improves"],
          draftImageAssetId: draftCoverAssetId,
          draftAssetPack: {
            character_cover: {
              assetId: draftCoverAssetId,
              bootstrapIdentity: true,
            },
            character_hero: {
              assetId: draftHeroAssetId,
              generationRouteFingerprint: routeFingerprint,
            },
            character_chat: {
              assetId: draftChatAssetId,
              generationRouteFingerprint: staleRouteFingerprint,
            },
          },
        },
        { id: projectB, characterId: characterB, phase: "live_management", audience: { label: "new users" }, hypothesis: "test", differentiation: "test", successCriteria: ["test"] },
      ],
    });
    await prisma.characterRelease.createMany({
      data: [
        {
          id: releaseA,
          projectId: projectA,
          revisionId: `revision-a-${suffix}`,
          characterContentVersionId: contentA,
          generationProvenance: { generationProfileKey: "profile", generationProfileVersion: "1", workflowKey: "workflow", workflowVersion: "1", policyVersion: "policy-v1" },
          releasePlacementManifest: {
            placements: [
              {
                slotKey: "character_avatar",
                slotVersion: 2,
                assetId: liveCoverAssetId,
              },
              {
                slotKey: "character_hero",
                slotVersion: 2,
                assetId: liveHeroAssetId,
              },
              {
                slotKey: "character_hero",
                slotVersion: 2,
                assetId: liveHeroAssetId,
              },
              {
                slotKey: "character_chat",
                slotVersion: 2,
                assetId: liveHeroAssetId,
              },
              {
                slotKey: "feed.hero",
                slotVersion: 2,
                assetId: liveHeroAssetId,
              },
            ],
          },
          snapshotHash: `snapshot-a-${suffix}`,
          // This fixture intentionally exercises the tolerant historical
          // portfolio projection rather than the strict v2 release lane.
          legacy: true,
          readiness: "ready",
          status: "published",
          publishedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
        {
          id: releaseB,
          projectId: projectB,
          revisionId: `revision-b-${suffix}`,
          characterContentVersionId: contentB,
          generationProvenance: {},
          releasePlacementManifest: {},
          snapshotHash: `snapshot-b-${suffix}`,
          legacy: true,
          readiness: "ready",
          status: "published",
          publishedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      ],
    });
    await prisma.characterServing.createMany({
      data: [
        { id: `serving-a-${suffix}`, characterId: characterA, currentReleaseId: releaseA, state: "live" },
        { id: `serving-b-${suffix}`, characterId: characterB, currentReleaseId: releaseB, state: "live" },
      ],
    });
    await prisma.adminUserGrantBundle.createMany({
      data: [
        {
          userId: scopedViewerId,
          bundleKey: "character_producer",
          scope: { characterIds: [characterA, characterB] },
          reason: "Portfolio cross-scope authorization fixture",
          createdById: adminId,
        },
        {
          userId: scopedViewerId,
          bundleKey: "creative_operator",
          scope: { characterIds: [characterB] },
          reason: "Portfolio draft image scope fixture",
          createdById: adminId,
        },
        {
          userId: globalCreativeViewerId,
          bundleKey: "creative_operator",
          reason: "Portfolio legal global creative grant fixture",
          createdById: adminId,
        },
        {
          userId: unscopedProducerViewerId,
          bundleKey: "character_producer",
          reason: "Portfolio malformed producer scope fixture",
          createdById: adminId,
        },
      ],
    });
    await prisma.characterFunnelDaily.createMany({
      data: [
        {
          characterId: characterA,
          characterContentVersionId: contentA,
          characterReleaseId: releaseA,
          placementId: null,
          productDay: new Date("2026-07-10T00:00:00.000Z"),
          metricVersion: 1,
          eligibleImpressions: 120,
          detailViews: 60,
          firstSuccessfulExchanges: 30,
          qceCount: 15,
          relationshipActivations: 8,
          sameCharacterD7EligiblePairs: 10,
          sameCharacterD7Returns: 4,
          paidAttributions: 3,
          coverageState: "exact",
          latestDataAt: new Date("2026-07-10T02:00:00.000Z"),
          sourceEvidence: ["golden:funnel:aggregate"],
        },
        {
          characterId: characterA,
          characterContentVersionId: contentA,
          characterReleaseId: releaseA,
          placementId: "feed.hero",
          productDay: new Date("2026-07-10T00:00:00.000Z"),
          metricVersion: 1,
          eligibleImpressions: 120,
          detailViews: 60,
          firstSuccessfulExchanges: 30,
          qceCount: 15,
          relationshipActivations: 8,
          sameCharacterD7EligiblePairs: 10,
          sameCharacterD7Returns: 4,
          paidAttributions: 3,
          coverageState: "exact",
          latestDataAt: new Date("2026-07-10T02:00:00.000Z"),
          sourceEvidence: ["golden:funnel:feed.hero"],
        },
      ],
    });
    const impressions = Array.from({ length: 120 }, (_, index) => ({
      id: `portfolio-impression-${suffix}-${index}`,
      exposureId: `portfolio-impression-${suffix}-${index}`,
      sourceService: "web",
      sourceEventId: `portfolio-impression-event-${suffix}-${index}`,
      userId: `portfolio-user-${index}`,
      journeyId: `portfolio-journey-${index}`,
      characterId: characterA,
      characterContentVersionId: contentA,
      characterReleaseId: releaseA,
      placementId: "feed.hero",
      eventType: "eligible_impression",
      visibleRatio: 0.8,
      visibleDurationMs: 800,
      environment: "production",
      dataClass: "customer",
      trustClass: "typed_client",
      eligible: true,
      occurredAt: new Date("2026-07-10T00:00:00.000Z"),
      validFrom: new Date("2026-07-10T00:00:00.000Z"),
      coverageState: "exact",
    }));
    const details = Array.from({ length: 60 }, (_, index) => ({
      id: `portfolio-detail-${suffix}-${index}`,
      exposureId: `portfolio-detail-${suffix}-${index}`,
      sourceService: "web",
      sourceEventId: `portfolio-detail-event-${suffix}-${index}`,
      userId: `portfolio-user-${index}`,
      journeyId: `portfolio-journey-${index}`,
      characterId: characterA,
      characterContentVersionId: contentA,
      characterReleaseId: releaseA,
      placementId: "feed.hero",
      eventType: "detail_view",
      parentExposureId: `portfolio-impression-${suffix}-${index}`,
      visibleRatio: 1,
      visibleDurationMs: 0,
      environment: "production",
      dataClass: "customer",
      trustClass: "typed_client",
      eligible: true,
      occurredAt: new Date("2026-07-10T01:00:00.000Z"),
      validFrom: new Date("2026-07-10T01:00:00.000Z"),
      coverageState: "exact",
    }));
    await prisma.characterExposureFact.createMany({ data: [...impressions, ...details] });
    // Counterexample: a historically unattributed row must never be guessed into
    // the current release merely because the Character matches.
    await prisma.characterExposureFact.create({
      data: {
        id: `portfolio-unattributed-${suffix}`,
        exposureId: `portfolio-unattributed-${suffix}`,
        sourceService: "legacy",
        sourceEventId: `portfolio-unattributed-event-${suffix}`,
        userId: "legacy-user",
        journeyId: "legacy-journey",
        characterId: characterA,
        characterContentVersionId: contentA,
        characterReleaseId: null,
        placementId: "feed.hero",
        eventType: "eligible_impression",
        visibleRatio: 1,
        visibleDurationMs: 1_000,
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        eligible: true,
        occurredAt: new Date("2026-07-10T00:00:00.000Z"),
        validFrom: new Date("2026-07-10T00:00:00.000Z"),
        coverageState: "exact_unattributed",
      },
    });
  });

  afterAll(async () => {
    await prisma.contentProductionBatch.deleteMany({
      where: { targetId: { in: [characterA, characterB] } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: [adminId, producerId] } } });
    await prisma.decisionRecord.deleteMany({ where: { sourceType: "character_portfolio", sourceId: { in: [characterA, characterB] } } });
    await prisma.characterEconomicsFact.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterExposureFact.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterFunnelDaily.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterServing.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterRelease.deleteMany({ where: { projectId: { in: [projectA, projectB] } } });
    await prisma.generationRouteQualification.deleteMany({ where: { id: qualificationId } });
    await prisma.generationModelProfile.deleteMany({ where: { id: generationProfileId } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { referenceSetRevisionId: { in: [referenceSetId, referenceSetBId] } },
    });
    await prisma.referenceSetRevision.deleteMany({
      where: { id: { in: [referenceSetId, referenceSetBId] } },
    });
    await prisma.characterVisualProfile.deleteMany({
      where: { id: { in: [visualProfileId, visualProfileBId] } },
    });
    await prisma.characterProject.deleteMany({ where: { id: { in: [projectA, projectB] } } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.character.deleteMany({ where: { id: { in: [characterA, characterB] } } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: mediaAssetIds } } });
    await prisma.adminUserGrantBundle.deleteMany({
      where: {
        userId: {
          in: [
            scopedViewerId,
            globalCreativeViewerId,
            unscopedProducerViewerId,
          ],
        },
      },
    });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [
            adminId,
            analystId,
            producerId,
            scopedViewerId,
            globalCreativeViewerId,
            unscopedProducerViewerId,
          ],
        },
      },
    });
    await prisma.$disconnect();
  });

  it("serves exact release/content/placement 7d and 28d metrics with fail-closed margin", async () => {
    const data = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      search: "Astra",
      limit: 20,
      placementId: "feed.hero",
    }), { asOf, authorizedDraftAssetCharacterIds: null });
    expect(data.items).toHaveLength(1);
    const item = data.items[0];
    expect(item.currentRelease?.id).toBe(releaseA);
    expect(item.visualProduction).toEqual({
      primaryImageUrl: `/media/${draftCoverAssetId}`,
      primaryImageSource: "draft",
      draftPurposes: ["character_cover", "character_hero"],
      livePurposes: ["character_cover", "character_hero"],
      totalPurposes: 3,
      deepLink: `/admin/characters/${characterA}?tab=assets`,
    });
    expect(item.journey.primaryAction).toEqual({
      code: "continue_asset_pack",
      deepLink: `/admin/characters/${characterA}?tab=assets`,
      command: null,
    });
    expect(item.performance.find((row) => row.window === "7d" && row.placementId === "feed.hero")).toMatchObject({
      characterContentVersionId: contentA,
      characterReleaseId: releaseA,
      eligibleImpressions: 120,
      detailViews: 60,
      detailCtr: 0.5,
      qceRate: 0.5,
      sameCharacterD7: 0.4,
      maturity: "mature",
      qualityState: "certified",
      contributionMargin: { valueMicros: null, qualityState: "invalid" },
    });
    expect(item.performance.find((row) => row.window === "7d" && row.placementId === "feed.hero")?.eligibleImpressions)
      .toBe(120);
  });

  // SPEC: 「需要处理」是运营每天的发现入口。它必须是真·筛选（进 where、影响分页），
  // 页内排序解决不了问题——第三页上那个零观测的角色永远翻不到。
  it("narrows the portfolio to live characters starved of observations", async () => {
    const all = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 50,
    }), { asOf, authorizedDraftAssetCharacterIds: null });
    const flagged = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 50,
      attention: true,
    }), { asOf, authorizedDraftAssetCharacterIds: null });

    const allIds = all.items.map((item) => item.characterId);
    const flaggedIds = flagged.items.map((item) => item.characterId);
    expect(allIds).toEqual(expect.arrayContaining([characterA, characterB]));
    // A 与 B 都在 2026-06-01 上线（asOf 是 07-11，7d 窗口早已走完）；A 有 120 次曝光事实，
    // B 一条观测都没有 —— 只有 B 该被筛出来。
    expect(flaggedIds).toContain(characterB);
    expect(flaggedIds).not.toContain(characterA);
  });

  it("returns an unfinished image run to the latest batch before ongoing production", async () => {
    const runId = `portfolio-active-image-run-${suffix}`;
    const originalProject = await prisma.characterProject.findUniqueOrThrow({
      where: { id: projectA },
      select: { draftImageAssetId: true, draftAssetPack: true },
    });
    await prisma.characterProject.update({
      where: { id: projectA },
      data: { draftImageAssetId: null, draftAssetPack: {} },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Astra unfinished hero batch",
        purpose: "character_hero",
        targetType: "character",
        targetId: characterA,
        presetIds: [],
        status: "reviewing",
        createdById: producerId,
      },
    });
    try {
      const data = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({ search: "Astra", limit: 20 }),
        { asOf, authorizedDraftAssetCharacterIds: null },
      );
      expect(data.items[0].journey.primaryAction).toEqual({
        code: "continue_image_run",
        deepLink: `/admin/characters/${characterA}?tab=assets`,
        command: null,
      });
    } finally {
      await prisma.contentProductionBatch.deleteMany({ where: { id: runId } });
      await prisma.characterProject.update({
        where: { id: projectA },
        data: {
          draftImageAssetId: originalProject.draftImageAssetId,
          draftAssetPack: toInputJson(originalProject.draftAssetPack),
        },
      });
    }
  });

  it("continues the image pack after visual production is ready instead of repeating setup", async () => {
    const originalProject = await prisma.characterProject.findUniqueOrThrow({
      where: { id: projectA },
      select: { draftImageAssetId: true, draftAssetPack: true },
    });
    await prisma.characterProject.update({
      where: { id: projectA },
      data: { draftImageAssetId: null, draftAssetPack: {} },
    });
    try {
      const data = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({ search: "Astra", limit: 20 }),
        { asOf, authorizedDraftAssetCharacterIds: null },
      );
      expect(data.items[0].journey.primaryAction).toEqual({
        code: "continue_asset_pack",
        deepLink: `/admin/characters/${characterA}?tab=assets`,
        command: null,
      });
    } finally {
      await prisma.characterProject.update({
        where: { id: projectA },
        data: {
          draftImageAssetId: originalProject.draftImageAssetId,
          draftAssetPack: toInputJson(originalProject.draftAssetPack),
        },
      });
    }
  });

  it("never presents an unavailable draft portrait as the primary role image", async () => {
    await prisma.mediaAsset.update({
      where: { id: draftCoverAssetId },
      data: {
        metadata: {
          platformAsset: {
            status: "archived",
          },
        },
      },
    });
    try {
      const data = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({
          search: "Astra",
          limit: 20,
        }),
        { asOf, authorizedDraftAssetCharacterIds: null },
      );
      expect(data.items[0].visualProduction).toMatchObject({
        primaryImageUrl: `/media/${liveCoverAssetId}`,
        primaryImageSource: "live",
        draftPurposes: ["character_hero"],
        livePurposes: ["character_cover", "character_hero"],
      });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: draftCoverAssetId },
        data: { metadata: {} },
      });
    }
  });

  it("projects an exact live portrait even when its relative URL is display-only", async () => {
    await prisma.mediaAsset.update({
      where: { id: draftCoverAssetId },
      data: {
        metadata: {
          platformAsset: {
            status: "archived",
          },
        },
      },
    });
    await prisma.mediaAsset.update({
      where: { id: liveCoverAssetId },
      data: {
        storageKey: null,
        url: "/images/ourdream/card-alexa-reeves.webp",
        thumbnailUrl: "/images/ourdream/card-alexa-reeves.webp",
      },
    });
    try {
      const data = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({
          search: "Astra",
          limit: 20,
        }),
        { asOf, authorizedDraftAssetCharacterIds: null },
      );
      expect(data.items[0].visualProduction).toMatchObject({
        primaryImageUrl: "/images/ourdream/card-alexa-reeves.webp",
        primaryImageSource: "live",
        livePurposes: ["character_cover", "character_hero"],
      });
    } finally {
      await prisma.mediaAsset.update({
        where: { id: liveCoverAssetId },
        data: {
          storageKey: `portfolio/${suffix}/${liveCoverAssetId}.webp`,
          url: `/media/${liveCoverAssetId}`,
          thumbnailUrl: null,
        },
      });
      await prisma.mediaAsset.update({
        where: { id: draftCoverAssetId },
        data: { metadata: {} },
      });
    }
  });

  it("accepts an unclaimed legacy portrait only while one Character references it", async () => {
    await prisma.mediaAsset.update({
      where: { id: draftCoverAssetId },
      data: {
        metadata: {
          platformAsset: {
            status: "archived",
          },
        },
      },
    });
    await prisma.mediaAsset.update({
      where: { id: liveCoverAssetId },
      data: { characterId: null },
    });
    try {
      const uniqueReference = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({
          search: "Astra",
          limit: 20,
        }),
        { asOf, authorizedDraftAssetCharacterIds: null },
      );
      expect(uniqueReference.items[0].visualProduction).toMatchObject({
        primaryImageUrl: `/media/${liveCoverAssetId}`,
        primaryImageSource: "live",
        livePurposes: ["character_cover", "character_hero"],
      });

      await prisma.character.update({
        where: { id: characterB },
        data: { imageAssetId: liveCoverAssetId },
      });
      const sharedReference = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({
          search: "Astra",
          limit: 20,
        }),
        { asOf, authorizedDraftAssetCharacterIds: null },
      );
      expect(sharedReference.items[0].visualProduction).toMatchObject({
        primaryImageUrl: null,
        primaryImageSource: null,
        livePurposes: ["character_hero"],
      });
    } finally {
      await prisma.character.update({
        where: { id: characterB },
        data: { imageAssetId: null },
      });
      await prisma.mediaAsset.update({
        where: { id: liveCoverAssetId },
        data: { characterId: characterA },
      });
      await prisma.mediaAsset.update({
        where: { id: draftCoverAssetId },
        data: { metadata: {} },
      });
    }
  });

  it("keeps only the existing bootstrap-cover exception when route authority is unavailable", async () => {
    await prisma.generationRouteQualification.update({
      where: { id: qualificationId },
      data: { result: "candidate" },
    });
    try {
      const data = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({
          search: "Astra",
          limit: 20,
        }),
        { asOf, authorizedDraftAssetCharacterIds: null },
      );
      expect(data.items[0].visualProduction).toMatchObject({
        primaryImageUrl: `/media/${draftCoverAssetId}`,
        primaryImageSource: "draft",
        draftPurposes: ["character_cover"],
        livePurposes: ["character_cover", "character_hero"],
      });
    } finally {
      await prisma.generationRouteQualification.update({
        where: { id: qualificationId },
        data: { result: "qualified" },
      });
    }
  });

  it("resolves a repeated visual route signature once and batches candidate media for the page", async () => {
    const routeFindMany = vi.spyOn(
      prisma.generationRouteQualification,
      "findMany",
    );
    const profileFindFirst = vi.spyOn(
      prisma.generationModelProfile,
      "findFirst",
    );
    const mediaFindMany = vi.spyOn(prisma.mediaAsset, "findMany");
    try {
      const data = await listCharacterPortfolioData(
        prisma,
        characterPortfolioQuerySchema.parse({ limit: 20 }),
        {
          asOf,
          authorizedCharacterIds: [characterA, characterB],
        },
      );

      expect(data.items.map((item) => item.characterId).sort()).toEqual(
        [characterA, characterB].sort(),
      );
      expect(routeFindMany).toHaveBeenCalledTimes(1);
      expect(profileFindFirst).toHaveBeenCalledTimes(1);
      expect(mediaFindMany).toHaveBeenCalledTimes(1);
    } finally {
      routeFindMany.mockRestore();
      profileFindFirst.mockRestore();
      mediaFindMany.mockRestore();
    }
  });

  it("uses one complete UTC product-day cohort and excludes the current partial day", async () => {
    const partialDayFactId = `portfolio-partial-day-${suffix}`;
    await prisma.characterFunnelDaily.create({
      data: {
        characterId: characterA,
        characterContentVersionId: contentA,
        characterReleaseId: releaseA,
        placementId: "feed.hero",
        productDay: new Date("2026-07-17T00:00:00.000Z"),
        metricVersion: 1,
        eligibleImpressions: 999,
        detailViews: 999,
        firstSuccessfulExchanges: 999,
        qceCount: 999,
        relationshipActivations: 999,
        sameCharacterD7EligiblePairs: 999,
        sameCharacterD7Returns: 999,
        paidAttributions: 999,
        coverageState: "exact",
        sourceEvidence: [partialDayFactId],
      },
    });
    await prisma.characterExposureFact.create({
      data: {
        id: partialDayFactId,
        exposureId: partialDayFactId,
        sourceService: "web",
        sourceEventId: `${partialDayFactId}-event`,
        userId: `${partialDayFactId}-user`,
        journeyId: `${partialDayFactId}-journey`,
        characterId: characterA,
        characterContentVersionId: contentA,
        characterReleaseId: releaseA,
        placementId: "feed.hero",
        eventType: "eligible_impression",
        visibleRatio: 1,
        visibleDurationMs: 1_000,
        environment: "production",
        dataClass: "customer",
        trustClass: "typed_client",
        eligible: true,
        occurredAt: new Date("2026-07-17T00:15:00.000Z"),
        validFrom: new Date("2026-07-17T00:15:00.000Z"),
        coverageState: "exact",
      },
    });
    try {
      const data = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
        search: "Astra",
        limit: 20,
        placementId: "feed.hero",
      }), { asOf: new Date("2026-07-17T12:30:00.000Z") });
      const summary = data.items[0].performance.find((row) =>
        row.window === "7d" && row.placementId === "feed.hero"
      );

      expect(summary).toMatchObject({
        windowStart: "2026-07-10T00:00:00.000Z",
        windowEnd: "2026-07-17T00:00:00.000Z",
        eligibleImpressions: 120,
        detailViews: 60,
        qualityState: "certified",
        coverageState: "exact",
        detailCtr: 0.5,
        chatStartRate: 0.5,
        qceRate: 0.5,
      });
      expect(summary?.evidence).toContain("window_grain:utc_product_day");
      expect(summary?.evidence).not.toContain("detail_view_parent_outside_reporting_cohort");
    } finally {
      await prisma.characterExposureFact.deleteMany({ where: { id: partialDayFactId } });
      await prisma.characterFunnelDaily.deleteMany({
        where: {
          characterId: characterA,
          characterReleaseId: releaseA,
          placementId: "feed.hero",
          productDay: new Date("2026-07-17T00:00:00.000Z"),
        },
      });
    }
  });

  it("uses deterministic server-side cursor pagination and assigned producer scope", async () => {
    const first = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ limit: 1 }), { asOf });
    expect(first.pageInfo).toMatchObject({ hasNextPage: true });
    const second = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 1,
      cursor: first.pageInfo.endCursor as string,
    }), { asOf });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].characterId).not.toBe(first.items[0].characterId);

    const assigned = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ limit: 20 }), {
      asOf,
      assignedActorId: producerId,
    });
    expect(assigned.items.map((item) => item.characterId)).toEqual([characterA]);
  });

  it("orders by recency on request and pages back to the page it came from", async () => {
    const all = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 20,
      sort: "updated_desc",
    }), { asOf });
    const projects = await prisma.characterProject.findMany({
      where: { characterId: { in: all.items.map((item) => item.characterId) } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { characterId: true },
    });
    expect(all.items.map((item) => item.characterId)).toEqual(projects.map((project) => project.characterId));
    expect(all.pageInfo.totalCount).toBe(projects.length);

    const first = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 1,
      sort: "updated_desc",
    }), { asOf });
    const second = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 1,
      sort: "updated_desc",
      cursor: first.pageInfo.endCursor as string,
    }), { asOf });
    const back = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 1,
      sort: "updated_desc",
      before: second.pageInfo.startCursor as string,
    }), { asOf });
    expect(back.items.map((item) => item.characterId)).toEqual(first.items.map((item) => item.characterId));
  });

  it("invalidates a cursor that was issued under a different sort", async () => {
    const first = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({ limit: 1 }), { asOf });
    await expect(listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      limit: 1,
      sort: "updated_desc",
      cursor: first.pageInfo.endCursor as string,
    }), { asOf })).rejects.toThrow(/invalid/);
  });

  it("records append-only Promote/Maintain/Improve/Pause/Retire evidence and filters by latest decision", async () => {
    const decision = await createCharacterPortfolioDecision(prisma, {
      characterId: characterA,
      actor: { id: adminId, role: "admin" },
      requestId: `portfolio-decision-request-${suffix}`,
      body: {
        releaseId: releaseA,
        decision: "Promote",
        question: "Should Astra receive more eligible exposure?",
        evidenceRefs: [`performance:${releaseA}:28d`],
        evidenceLevel: "attribution",
        confidence: 0.8,
        successCriteria: ["Eligible impressions increase without D7 regression"],
        guardrails: ["same-character D7 must not decline"],
        reviewAt: "2026-07-18T00:00:00.000Z",
      },
    });
    expect(decision).toMatchObject({ decision: "Promote", releaseId: releaseA, evidenceLevel: "attribution" });
    const filtered = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      decision: "Promote",
      limit: 20,
    }), { asOf });
    expect(filtered.items.map((item) => item.characterId)).toEqual([characterA]);
    expect(filtered.items[0].latestDecision?.id).toBe(decision.id);
  });

  it("enforces character.performance.read on the HTTP read surface", async () => {
    const denied = await listCharacterPortfolio(new Request("http://localhost/api/v2/admin/characters/portfolio", {
      headers: { "x-idream-user-id": producerId, "x-idream-role": "user" },
    })).catch((error: unknown) => error);
    expect(denied).toMatchObject({ status: 403 });

    const allowed = await listCharacterPortfolio(new Request("http://localhost/api/v2/admin/characters/portfolio?search=Astra", {
      headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" },
    }));
    expect(allowed.status).toBe(200);

    const performanceOnly = await listCharacterPortfolio(new Request(
      "http://localhost/api/v2/admin/characters/portfolio?search=Astra",
      {
        headers: {
          "x-idream-user-id": analystId,
          "x-idream-role": "analyst",
        },
      },
    ));
    expect(performanceOnly.status).toBe(200);
    const payload = await performanceOnly.json();
    expect(payload.data.items[0].visualProduction).toMatchObject({
      primaryImageUrl: `/media/${liveCoverAssetId}`,
      primaryImageSource: "live",
      draftPurposes: [],
      livePurposes: ["character_cover", "character_hero"],
    });
  });

  it("projects draft role images only inside the creative.run.read Character scope", async () => {
    const originalProjectB = await prisma.characterProject.findUniqueOrThrow({
      where: { id: projectB },
      select: { draftImageAssetId: true, draftAssetPack: true },
    });
    await prisma.characterProject.update({
      where: { id: projectB },
      data: {
        draftImageAssetId: characterBAnchorAssetId,
        draftAssetPack: {
          character_cover: {
            assetId: characterBAnchorAssetId,
            bootstrapIdentity: true,
          },
        },
      },
    });
    try {
      const response = await listCharacterPortfolio(new Request(
        "http://localhost/api/v2/admin/characters/portfolio?limit=20",
        {
          headers: {
            "x-idream-user-id": scopedViewerId,
            "x-idream-role": "user",
          },
        },
      ));
      expect(response.status).toBe(200);
      const payload = await response.json();
      const itemA = payload.data.items.find(
        (item: { characterId: string }) => item.characterId === characterA,
      );
      const itemB = payload.data.items.find(
        (item: { characterId: string }) => item.characterId === characterB,
      );
      expect(itemA.visualProduction).toMatchObject({
        primaryImageUrl: `/media/${liveCoverAssetId}`,
        primaryImageSource: "live",
        draftPurposes: [],
      });
      expect(itemB.visualProduction).toMatchObject({
        primaryImageUrl: `/media/${characterBAnchorAssetId}`,
        primaryImageSource: "draft",
        draftPurposes: ["character_cover"],
      });
    } finally {
      await prisma.characterProject.update({
        where: { id: projectB },
        data: {
          draftImageAssetId: originalProjectB.draftImageAssetId,
          draftAssetPack: toInputJson(originalProjectB.draftAssetPack),
        },
      });
    }
  });

  it("projects A/B draft role images for a legal global creative_operator grant", async () => {
    const globalGrant = await prisma.adminUserGrantBundle.findUniqueOrThrow({
      where: {
        userId_bundleKey: {
          userId: globalCreativeViewerId,
          bundleKey: "creative_operator",
        },
      },
      select: { scope: true },
    });
    expect(globalGrant.scope).toBeNull();

    const originalProjectB = await prisma.characterProject.findUniqueOrThrow({
      where: { id: projectB },
      select: { draftImageAssetId: true, draftAssetPack: true },
    });
    await prisma.characterProject.update({
      where: { id: projectB },
      data: {
        draftImageAssetId: characterBAnchorAssetId,
        draftAssetPack: {
          character_cover: {
            assetId: characterBAnchorAssetId,
            bootstrapIdentity: true,
          },
        },
      },
    });
    try {
      const response = await listCharacterPortfolio(new Request(
        "http://localhost/api/v2/admin/characters/portfolio?limit=20",
        {
          headers: {
            "x-idream-user-id": globalCreativeViewerId,
            "x-idream-role": "analyst",
          },
        },
      ));
      expect(response.status).toBe(200);
      const payload = await response.json();
      const itemA = payload.data.items.find(
        (item: { characterId: string }) => item.characterId === characterA,
      );
      const itemB = payload.data.items.find(
        (item: { characterId: string }) => item.characterId === characterB,
      );
      expect(itemA.visualProduction).toMatchObject({
        primaryImageUrl: `/media/${draftCoverAssetId}`,
        primaryImageSource: "draft",
        draftPurposes: ["character_cover", "character_hero"],
      });
      expect(itemB.visualProduction).toMatchObject({
        primaryImageUrl: `/media/${characterBAnchorAssetId}`,
        primaryImageSource: "draft",
        draftPurposes: ["character_cover"],
      });
    } finally {
      await prisma.characterProject.update({
        where: { id: projectB },
        data: {
          draftImageAssetId: originalProjectB.draftImageAssetId,
          draftAssetPack: toInputJson(originalProjectB.draftAssetPack),
        },
      });
    }
  });

  it("fails closed when character_producer is persisted without Character scope", async () => {
    const malformedGrant = await prisma.adminUserGrantBundle.findUniqueOrThrow({
      where: {
        userId_bundleKey: {
          userId: unscopedProducerViewerId,
          bundleKey: "character_producer",
        },
      },
      select: { scope: true },
    });
    expect(malformedGrant.scope).toBeNull();

    const response = await listCharacterPortfolio(new Request(
      "http://localhost/api/v2/admin/characters/portfolio?limit=20",
      {
        headers: {
          "x-idream-user-id": unscopedProducerViewerId,
          "x-idream-role": "user",
        },
      },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [] },
    });
  });

  it("keeps the Portfolio usable but degraded when reconciliation finds an orphan Project", async () => {
    const orphanProjectId = `portfolio-orphan-${suffix}`;
    await prisma.characterProject.create({
      data: {
        id: orphanProjectId,
        characterId: `missing-character-${suffix}`,
        phase: "qa",
        audience: {},
        successCriteria: [],
      },
    });
    try {
      const data = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
        phase: "qa",
        limit: 20,
      }), { asOf });
      expect(data.items).toEqual([]);
      expect(data.freshness).toBe("degraded");
      expect(data.dataQuality).toContainEqual(expect.objectContaining({
        code: "character_project_orphan",
        severity: "error",
      }));
    } finally {
      await prisma.characterProject.deleteMany({ where: { id: orphanProjectId } });
    }
  });
});
