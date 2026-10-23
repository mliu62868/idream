import {
  characterPerformanceReconciliationSchema,
} from "@idream/shared/admin";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { toInputJson } from "../shared/prisma-json";

export interface CharacterPerformanceBackfillOptions {
  readonly source: string;
  readonly dryRun: boolean;
  readonly batchSize: number;
  readonly cursor?: string | null;
  readonly asOf?: Date;
}

type BackfillDb = PrismaClient | Prisma.TransactionClient;

export async function readCharacterVariableCostCoverage(
  db: BackfillDb,
  scope?: {
    readonly characterId: string;
    readonly releaseId: string;
    readonly windowStart: Date;
    readonly windowEnd: Date;
  },
) {
  const sourceScope = scope ? Prisma.sql`
    AND usage."characterId" = ${scope.characterId}
    AND usage."releaseId" = ${scope.releaseId}
    AND usage."occurredAt" >= ${scope.windowStart}
    AND usage."occurredAt" < ${scope.windowEnd}
  ` : Prisma.empty;
  const projectionScope = scope ? Prisma.sql`
    AND fact."characterId" = ${scope.characterId}
    AND fact."characterReleaseId" = ${scope.releaseId}
    AND fact."occurredAt" >= ${scope.windowStart}
    AND fact."occurredAt" < ${scope.windowEnd}
  ` : Prisma.empty;
  // Invocation facts include real failed/retried calls. Pricing and projection
  // completeness must not filter them, or unpriced calls disappear from coverage.
  // Match both sides by authority: an orphan projection cannot cancel a missing one.
  const [counts] = await db.$queryRaw<Array<{
    relevant: bigint;
    projected: bigint;
    missing: bigint;
    unmatchedProjections: bigint;
  }>>(Prisma.sql`
    WITH sources AS (
      SELECT usage.*, release."characterContentVersionId" AS "contentVersionId",
        project."characterId" AS "releaseCharacterId"
      FROM ai_usage_facts usage
      LEFT JOIN character_releases release ON release.id = usage."releaseId"
      LEFT JOIN character_projects project ON project.id = release."projectId"
      WHERE usage.environment = 'production' AND usage."dataClass" = 'customer'
        AND usage."trustClass" = 'canonical' AND usage."actorIsInternal" = false
        AND usage."characterId" IS NOT NULL AND usage."releaseId" IS NOT NULL
        ${sourceScope}
    ), projections AS (
      SELECT fact.* FROM character_economics_facts fact
      WHERE fact."authorityType" = 'ai_usage_fact' AND fact.kind = 'variable_cost'
        ${projectionScope}
    ), matches AS (
      SELECT source.id AS "sourceId", fact.id AS "projectionId", COALESCE(
        source.id IS NOT NULL AND fact.id IS NOT NULL
        AND source."costMicros" >= 0 AND NULLIF(BTRIM(source."pricingVersion"), '') IS NOT NULL
        AND source."releaseCharacterId" = source."characterId"
        AND fact."characterId" = source."characterId"
        AND fact."characterReleaseId" = source."releaseId"
        AND fact."characterContentVersionId" = source."contentVersionId"
        AND fact."placementId" IS NULL AND fact."amountMicros" = source."costMicros"
        AND UPPER(fact.currency) = 'USD' AND fact."occurredAt" = source."occurredAt"
        AND fact."auditState" = 'audited' AND fact."coverageState" = 'exact', false
      ) AS matched
      FROM sources source FULL JOIN projections fact ON fact."authorityId" = source.id
    )
    SELECT COUNT("sourceId") AS relevant,
      COUNT(*) FILTER (WHERE matched) AS projected,
      COUNT(*) FILTER (WHERE "sourceId" IS NOT NULL AND NOT matched) AS missing,
      COUNT(*) FILTER (WHERE "projectionId" IS NOT NULL AND NOT matched) AS "unmatchedProjections"
    FROM matches
  `);
  return {
    relevantCostAuthorities: Number(counts.relevant),
    projectedCostAuthorities: Number(counts.projected),
    missingVariableCostFacts: Number(counts.missing),
    complete: counts.missing === BigInt(0) && counts.unmatchedProjections === BigInt(0),
  };
}

function nextDay(day: Date) {
  return new Date(day.getTime() + 24 * 60 * 60 * 1_000);
}

export async function backfillCharacterFunnelFacts(
  db: BackfillDb,
  options: CharacterPerformanceBackfillOptions,
) {
  const limit = Math.max(1, Math.min(1_000, options.batchSize));
  const before = { funnelRows: await db.characterFunnelDaily.count() };
  const rows = await db.chatExchangeFact.findMany({
    where: {
      id: options.cursor ? { gt: options.cursor } : undefined,
      eligible: true,
      characterReleaseId: { not: null },
      coverageState: "exact",
    },
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  const batch = rows.slice(0, limit);
  const keys = new Map<string, (typeof batch)[number]>();
  for (const row of batch) {
    keys.set(`${row.characterId}|${row.characterContentVersionId}|${row.characterReleaseId}|${row.productDay.toISOString()}`, row);
  }
  const run = await db.metricBackfillRun.create({
    data: {
      source: options.source,
      status: "running",
      dryRun: options.dryRun,
      cursor: options.cursor,
      batchSize: limit,
      beforeSnapshot: toInputJson(before),
      afterSnapshot: toInputJson(before),
      mismatchReport: [],
      validFrom: batch.reduce<Date | null>((earliest, row) =>
        earliest === null || row.occurredAt < earliest ? row.occurredAt : earliest, null),
    },
  });
  let appliedCount = 0;
  let skippedCount = 0;
  const mismatches: Array<Record<string, unknown>> = [];
  if (!options.dryRun) {
    for (const row of keys.values()) {
      try {
        const releaseId = row.characterReleaseId as string;
        const dayRows = await db.chatExchangeFact.findMany({
          where: {
            characterId: row.characterId,
            characterContentVersionId: row.characterContentVersionId,
            characterReleaseId: releaseId,
            eligible: true,
            coverageState: "exact",
            occurredAt: { gte: row.productDay, lt: nextDay(row.productDay) },
          },
          select: { engagementSessionId: true, exchangeId: true, occurredAt: true },
        });
        const exchangesBySession = new Map<string, Set<string>>();
        for (const exchange of dayRows) {
          const exchanges = exchangesBySession.get(exchange.engagementSessionId) ?? new Set<string>();
          exchanges.add(exchange.exchangeId);
          exchangesBySession.set(exchange.engagementSessionId, exchanges);
        }
        const existing = await db.characterFunnelDaily.findFirst({
          where: {
            characterContentVersionId: row.characterContentVersionId,
            characterReleaseId: releaseId,
            placementId: null,
            productDay: row.productDay,
            metricVersion: 1,
          },
        });
        if (existing?.coverageState === "exact") {
          skippedCount += 1;
          continue;
        }
        const data = {
          characterId: row.characterId,
          characterContentVersionId: row.characterContentVersionId,
          characterReleaseId: releaseId,
          placementId: null,
          productDay: row.productDay,
          metricVersion: 1,
          firstSuccessfulExchanges: exchangesBySession.size,
          qceCount: [...exchangesBySession.values()].filter((exchanges) => exchanges.size >= 5).length,
          coverageState: "partial_no_exposure_chain_or_d7_cohort",
          projectionVersion: 1,
          latestDataAt: dayRows.reduce<Date | null>((latest, item) =>
            latest === null || item.occurredAt > latest ? item.occurredAt : latest, null),
          sourceEvidence: toInputJson(["chat_exchange_facts:exact", "placement:unavailable", "d7_cohort:unavailable"]),
        };
        if (existing) await db.characterFunnelDaily.update({ where: { id: existing.id }, data });
        else await db.characterFunnelDaily.create({ data });
        appliedCount += 1;
      } catch (error) {
        mismatches.push({
          cursor: row.id,
          message: error instanceof Error ? error.message : "unknown funnel backfill failure",
        });
      }
    }
  }
  const hasMore = rows.length > limit;
  const nextCursor = hasMore ? batch.at(-1)?.id ?? options.cursor ?? null : null;
  const after = { funnelRows: await db.characterFunnelDaily.count() };
  await db.metricBackfillRun.update({
    where: { id: run.id },
    data: {
      status: hasMore ? "paused" : "completed",
      cursor: nextCursor,
      scannedCount: batch.length,
      appliedCount,
      skippedCount,
      mismatchCount: mismatches.length,
      coverage: batch.length === 0 ? 1 : (appliedCount + skippedCount) / batch.length,
      afterSnapshot: toInputJson(after),
      mismatchReport: toInputJson(mismatches),
      completedAt: hasMore ? null : new Date(),
    },
  });
  return {
    runId: run.id,
    status: hasMore ? "paused" as const : "completed" as const,
    dryRun: options.dryRun,
    scannedCount: batch.length,
    wouldApplyCount: keys.size,
    appliedCount,
    skippedCount,
    mismatchCount: mismatches.length,
    nextCursor,
    before,
    after,
    mismatches,
  };
}

export async function backfillCharacterVariableCostFacts(
  db: BackfillDb,
  options: CharacterPerformanceBackfillOptions,
) {
  const limit = Math.max(1, Math.min(1_000, options.batchSize));
  const before = { economicsFacts: await db.characterEconomicsFact.count() };
  const rows = await db.aiUsageFact.findMany({
    where: {
      id: options.cursor ? { gt: options.cursor } : undefined,
      characterId: { not: null },
      releaseId: { not: null },
      costMicros: { not: null },
      pricingVersion: { not: null },
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actorIsInternal: false,
    },
    orderBy: { id: "asc" },
    take: limit + 1,
  });
  const batch = rows.slice(0, limit);
  const run = await db.metricBackfillRun.create({
    data: {
      source: options.source,
      status: "running",
      dryRun: options.dryRun,
      cursor: options.cursor,
      batchSize: limit,
      beforeSnapshot: toInputJson(before),
      afterSnapshot: toInputJson(before),
      mismatchReport: [],
      validFrom: batch.reduce<Date | null>((earliest, row) =>
        earliest === null || row.occurredAt < earliest ? row.occurredAt : earliest, null),
    },
  });
  let appliedCount = 0;
  let skippedCount = 0;
  const mismatches: Array<Record<string, unknown>> = [];
  if (!options.dryRun) {
    for (const row of batch) {
      try {
        const release = await db.characterRelease.findUnique({ where: { id: row.releaseId as string } });
        if (!release || release.characterContentVersionId.length === 0) {
          mismatches.push({ cursor: row.id, reason: "release_or_content_version_missing" });
          continue;
        }
        const existing = await db.characterEconomicsFact.findUnique({
          where: {
            authorityType_authorityId_kind: {
              authorityType: "ai_usage_fact",
              authorityId: row.id,
              kind: "variable_cost",
            },
          },
        });
        if (existing) {
          skippedCount += 1;
          continue;
        }
        await db.characterEconomicsFact.create({
          data: {
            characterId: row.characterId as string,
            characterContentVersionId: release.characterContentVersionId,
            characterReleaseId: row.releaseId as string,
            placementId: null,
            kind: "variable_cost",
            amountMicros: row.costMicros as bigint,
            currency: "USD",
            authorityType: "ai_usage_fact",
            authorityId: row.id,
            attributionMethod: "exact_character_release_no_placement",
            auditState: "audited",
            coverageState: "exact",
            occurredAt: row.occurredAt,
          },
        });
        appliedCount += 1;
      } catch (error) {
        mismatches.push({
          cursor: row.id,
          message: error instanceof Error ? error.message : "unknown cost backfill failure",
        });
      }
    }
  }
  const hasMore = rows.length > limit;
  const nextCursor = hasMore ? batch.at(-1)?.id ?? options.cursor ?? null : null;
  const after = { economicsFacts: await db.characterEconomicsFact.count() };
  await db.metricBackfillRun.update({
    where: { id: run.id },
    data: {
      status: hasMore ? "paused" : "completed",
      cursor: nextCursor,
      scannedCount: batch.length,
      appliedCount,
      skippedCount,
      mismatchCount: mismatches.length,
      coverage: batch.length === 0 ? 1 : (appliedCount + skippedCount) / batch.length,
      afterSnapshot: toInputJson(after),
      mismatchReport: toInputJson(mismatches),
      completedAt: hasMore ? null : new Date(),
    },
  });
  return {
    runId: run.id,
    status: hasMore ? "paused" as const : "completed" as const,
    dryRun: options.dryRun,
    scannedCount: batch.length,
    wouldApplyCount: batch.length,
    appliedCount,
    skippedCount,
    mismatchCount: mismatches.length,
    nextCursor,
    before,
    after,
    mismatches,
  };
}

export async function reconcileCharacterPerformanceFacts(db: PrismaClient) {
  const [funnelRows, costCoverage, unauditedEconomics, partialEconomics] = await Promise.all([
    db.characterFunnelDaily.findMany({
      select: {
        characterReleaseId: true,
        characterContentVersionId: true,
        eligibleImpressions: true,
        detailViews: true,
        firstSuccessfulExchanges: true,
        qceCount: true,
        sameCharacterD7EligiblePairs: true,
        sameCharacterD7Returns: true,
        coverageState: true,
      },
    }),
    readCharacterVariableCostCoverage(db),
    db.characterEconomicsFact.count({ where: { auditState: { not: "audited" } } }),
    db.characterEconomicsFact.count({ where: { coverageState: { not: "exact" } } }),
  ]);
  const impossibleFunnelRows = funnelRows.filter((row) =>
    row.coverageState === "exact" && (
      row.detailViews > row.eligibleImpressions ||
      row.firstSuccessfulExchanges > row.detailViews ||
      row.qceCount > row.firstSuccessfulExchanges ||
      row.sameCharacterD7Returns > row.sameCharacterD7EligiblePairs
    )).length;
  const missingReleaseRows = funnelRows.filter((row) => row.characterReleaseId === null).length;
  const nonExactFunnelRows = funnelRows.filter((row) => row.coverageState !== "exact").length;
  return {
    scannedFunnelRows: funnelRows.length,
    impossibleFunnelRows,
    missingReleaseRows,
    nonExactFunnelRows,
    relevantCostAuthorities: costCoverage.relevantCostAuthorities,
    projectedCostAuthorities: costCoverage.projectedCostAuthorities,
    missingVariableCostFacts: costCoverage.missingVariableCostFacts,
    unauditedEconomicsFacts: unauditedEconomics,
    partialEconomicsFacts: partialEconomics,
    cashRevenueAuthorityState: "unavailable" as const,
    refundAuthorityState: "unavailable" as const,
    creditAuthorityState: "unavailable" as const,
    qualityState: impossibleFunnelRows === 0 && costCoverage.complete &&
      unauditedEconomics === 0 && partialEconomics === 0
      ? "directional" as const
      : "invalid" as const,
  };
}

export async function getCharacterPerformanceReconciliation(request: Request) {
  await actorWithPermission(request, "analytics.metric.read");
  return ok(characterPerformanceReconciliationSchema.parse(
    await reconcileCharacterPerformanceFacts(prisma),
  ), { headers: { "cache-control": "no-store" } });
}
