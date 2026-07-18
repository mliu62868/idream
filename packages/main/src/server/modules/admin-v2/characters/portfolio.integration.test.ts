import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterPortfolioQuerySchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { createUser } from "@/server/test/helpers";
import {
  createCharacterPortfolioDecision,
  listCharacterPortfolio,
  listCharacterPortfolioData,
} from "./portfolio";

describe("Character Portfolio authority/read model", () => {
  const suffix = randomUUID();
  const adminId = `portfolio-admin-${suffix}`;
  const producerId = `portfolio-producer-${suffix}`;
  const characterA = `portfolio-character-a-${suffix}`;
  const characterB = `portfolio-character-b-${suffix}`;
  const projectA = `portfolio-project-a-${suffix}`;
  const projectB = `portfolio-project-b-${suffix}`;
  const contentA = `portfolio-content-a-${suffix}`;
  const contentB = `portfolio-content-b-${suffix}`;
  const releaseA = `portfolio-release-a-${suffix}`;
  const releaseB = `portfolio-release-b-${suffix}`;
  const asOf = new Date("2026-07-11T00:00:00.000Z");

  beforeAll(async () => {
    await createUser({ id: adminId, role: "admin" });
    await createUser({ id: producerId, role: "user" });
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
    await prisma.characterContentVersion.createMany({
      data: [
        { id: contentA, characterId: characterA, version: 1, contentHash: `hash-a-${suffix}`, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" },
        { id: contentB, characterId: characterB, version: 1, contentHash: `hash-b-${suffix}`, personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" },
      ],
    });
    await prisma.characterProject.createMany({
      data: [
        { id: projectA, characterId: characterA, ownerId: producerId, phase: "live_management", audience: { label: "returning companion users", companionNeed: "continuity", targetPlacementKeys: ["feed.hero"] }, hypothesis: "continuity increases D7", differentiation: "memory", successCriteria: ["D7 improves"] },
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
          releasePlacementManifest: { placements: [{ slotKey: "feed.hero", slotVersion: 2, assetId: `asset-a-${suffix}` }] },
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
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: [adminId, producerId] } } });
    await prisma.decisionRecord.deleteMany({ where: { sourceType: "character_portfolio", sourceId: { in: [characterA, characterB] } } });
    await prisma.characterEconomicsFact.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterExposureFact.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterFunnelDaily.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterServing.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.characterRelease.deleteMany({ where: { projectId: { in: [projectA, projectB] } } });
    await prisma.characterProject.deleteMany({ where: { id: { in: [projectA, projectB] } } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: [characterA, characterB] } } });
    await prisma.character.deleteMany({ where: { id: { in: [characterA, characterB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, producerId] } } });
    await prisma.$disconnect();
  });

  it("serves exact release/content/placement 7d and 28d metrics with fail-closed margin", async () => {
    const data = await listCharacterPortfolioData(prisma, characterPortfolioQuerySchema.parse({
      search: "Astra",
      limit: 20,
      placementId: "feed.hero",
    }), { asOf });
    expect(data.items).toHaveLength(1);
    const item = data.items[0];
    expect(item.currentRelease?.id).toBe(releaseA);
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
