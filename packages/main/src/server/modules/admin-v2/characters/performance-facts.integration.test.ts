import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  backfillCharacterFunnelFacts,
  backfillCharacterVariableCostFacts,
  reconcileCharacterPerformanceFacts,
} from "./performance-facts";

describe("Character Performance resumable fact backfills", () => {
  const suffix = randomUUID();
  const characterId = `performance-backfill-character-${suffix}`;
  const contentId = `performance-backfill-content-${suffix}`;
  const projectId = `performance-backfill-project-${suffix}`;
  const releaseId = `performance-backfill-release-${suffix}`;
  const sourcePrefix = `character-performance-test-${suffix}`;

  beforeAll(async () => {
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `performance-backfill-hash-${suffix}`,
        personaSnapshot: {},
        openingSnapshot: {},
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    await prisma.characterProject.create({
      data: { id: projectId, characterId, phase: "live_management", audience: {}, successCriteria: [] },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `performance-backfill-revision-${suffix}`,
        characterContentVersionId: contentId,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `performance-backfill-snapshot-${suffix}`,
        status: "published",
        publishedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    await prisma.chatExchangeFact.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        id: `performance-backfill-exchange-fact-${suffix}-${index}`,
        exchangeId: `performance-backfill-exchange-${suffix}-${index}`,
        sourceService: "chat",
        sourceEventId: `performance-backfill-exchange-event-${suffix}-${index}`,
        userMessageId: `performance-backfill-user-message-${suffix}-${index}`,
        assistantMessageId: `performance-backfill-assistant-${suffix}-${index}`,
        selectedAssistantMessageId: `performance-backfill-assistant-${suffix}-${index}`,
        assistantAttemptNo: 1,
        sessionId: `performance-backfill-session-${suffix}`,
        engagementSessionId: `performance-backfill-engagement-${suffix}`,
        userId: `performance-backfill-user-${suffix}`,
        characterId,
        characterContentVersionId: contentId,
        characterReleaseId: releaseId,
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        eligible: true,
        occurredAt: new Date(`2026-07-02T00:0${index}:00.000Z`),
        productDay: new Date("2026-07-02T00:00:00.000Z"),
        sourceUpdatedAt: new Date(`2026-07-02T00:0${index}:00.000Z`),
        validFrom: new Date(`2026-07-02T00:0${index}:00.000Z`),
        coverageState: "exact",
      })),
    });
    await prisma.aiUsageFact.create({
      data: {
        id: `performance-backfill-usage-${suffix}`,
        source: `invocation-${suffix}`,
        sourceService: "chat",
        sourceEventId: `performance-backfill-usage-event-${suffix}`,
        characterId,
        releaseId,
        provider: "mock",
        model: "test-model",
        usage: { outputTokens: 100 },
        costMicros: BigInt(321),
        pricingVersion: "pricing-v1",
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actorIsInternal: false,
        occurredAt: new Date("2026-07-02T00:10:00.000Z"),
      },
    });
  });

  afterAll(async () => {
    await prisma.metricBackfillRun.deleteMany({ where: { source: { startsWith: sourcePrefix } } });
    await prisma.characterEconomicsFact.deleteMany({ where: { characterId } });
    await prisma.characterFunnelDaily.deleteMany({ where: { characterId } });
    await prisma.aiUsageFact.deleteMany({ where: { characterId } });
    await prisma.chatExchangeFact.deleteMany({ where: { characterId } });
    await prisma.characterRelease.delete({ where: { id: releaseId } });
    await prisma.characterProject.delete({ where: { id: projectId } });
    await prisma.characterContentVersion.delete({ where: { id: contentId } });
    await prisma.$disconnect();
  });

  it("dry-runs then idempotently projects partial chat aggregates without guessing placement or D7", async () => {
    const dryRun = await backfillCharacterFunnelFacts(prisma, {
      source: `${sourcePrefix}:funnel:dry`,
      dryRun: true,
      batchSize: 100,
    });
    expect(dryRun).toMatchObject({ scannedCount: 5, wouldApplyCount: 1, appliedCount: 0 });
    expect(await prisma.characterFunnelDaily.count({ where: { characterId } })).toBe(0);

    const applied = await backfillCharacterFunnelFacts(prisma, {
      source: `${sourcePrefix}:funnel:apply`,
      dryRun: false,
      batchSize: 100,
    });
    expect(applied).toMatchObject({ status: "completed", appliedCount: 1, mismatchCount: 0 });
    expect(await prisma.characterFunnelDaily.findFirstOrThrow({ where: { characterId } })).toMatchObject({
      placementId: null,
      firstSuccessfulExchanges: 1,
      qceCount: 1,
      sameCharacterD7EligiblePairs: 0,
      coverageState: "partial_no_exposure_chain_or_d7_cohort",
    });

    const replay = await backfillCharacterFunnelFacts(prisma, {
      source: `${sourcePrefix}:funnel:replay`,
      dryRun: false,
      batchSize: 100,
    });
    expect(replay).toMatchObject({ appliedCount: 1, mismatchCount: 0 });
    expect(await prisma.characterFunnelDaily.count({ where: { characterId } })).toBe(1);
  });

  it("projects only auditable exact-release AI costs and remains idempotent", async () => {
    const first = await backfillCharacterVariableCostFacts(prisma, {
      source: `${sourcePrefix}:cost:apply`,
      dryRun: false,
      batchSize: 100,
    });
    expect(first).toMatchObject({ appliedCount: 1, mismatchCount: 0 });
    expect(await prisma.characterEconomicsFact.findFirstOrThrow({ where: { characterId } })).toMatchObject({
      characterContentVersionId: contentId,
      characterReleaseId: releaseId,
      placementId: null,
      kind: "variable_cost",
      amountMicros: BigInt(321),
      attributionMethod: "exact_character_release_no_placement",
      auditState: "audited",
    });
    const replay = await backfillCharacterVariableCostFacts(prisma, {
      source: `${sourcePrefix}:cost:replay`,
      dryRun: false,
      batchSize: 100,
    });
    expect(replay).toMatchObject({ appliedCount: 0, skippedCount: 1 });
    expect(await prisma.characterEconomicsFact.count({ where: { characterId } })).toBe(1);
  });

  it("reconciles cost authority while explicitly leaving cash/refund/credit unavailable", async () => {
    const report = await reconcileCharacterPerformanceFacts(prisma);
    expect(report).toMatchObject({
      impossibleFunnelRows: 0,
      missingVariableCostFacts: 0,
      cashRevenueAuthorityState: "unavailable",
      refundAuthorityState: "unavailable",
      creditAuthorityState: "unavailable",
    });
  });
});
