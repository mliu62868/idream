import {
  characterPerformanceBackfillRequestSchema,
  characterPerformanceBackfillResponseSchema,
  characterPerformanceReconciliationSchema,
} from "@idream/shared/admin";
import type { PrismaClient } from "@prisma/client";
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

function nextDay(day: Date) {
  return new Date(day.getTime() + 24 * 60 * 60 * 1_000);
}

export async function backfillCharacterFunnelFacts(
  db: PrismaClient,
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
  db: PrismaClient,
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
  const [funnelRows, relevantCosts, projectedCosts, unauditedEconomics, partialEconomics] = await Promise.all([
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
    db.aiUsageFact.count({
      where: {
        characterId: { not: null },
        releaseId: { not: null },
        costMicros: { not: null },
        pricingVersion: { not: null },
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actorIsInternal: false,
      },
    }),
    db.characterEconomicsFact.count({ where: { authorityType: "ai_usage_fact", kind: "variable_cost" } }),
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
  const missingVariableCostFacts = Math.max(0, relevantCosts - projectedCosts);
  return {
    scannedFunnelRows: funnelRows.length,
    impossibleFunnelRows,
    missingReleaseRows,
    nonExactFunnelRows,
    relevantCostAuthorities: relevantCosts,
    projectedCostAuthorities: projectedCosts,
    missingVariableCostFacts,
    unauditedEconomicsFacts: unauditedEconomics,
    partialEconomicsFacts: partialEconomics,
    cashRevenueAuthorityState: "unavailable" as const,
    refundAuthorityState: "unavailable" as const,
    creditAuthorityState: "unavailable" as const,
    qualityState: impossibleFunnelRows === 0 && missingVariableCostFacts === 0 &&
      unauditedEconomics === 0 && partialEconomics === 0
      ? "directional" as const
      : "invalid" as const,
  };
}

export async function runCharacterPerformanceBackfill(request: Request) {
  await actorWithPermission(request, "analytics.metric.export");
  const body = characterPerformanceBackfillRequestSchema.parse(await request.json());
  const report = body.kind === "funnel"
    ? await backfillCharacterFunnelFacts(prisma, body)
    : await backfillCharacterVariableCostFacts(prisma, body);
  return ok(characterPerformanceBackfillResponseSchema.parse(report), {
    headers: { "cache-control": "no-store" },
  });
}

export async function getCharacterPerformanceReconciliation(request: Request) {
  await actorWithPermission(request, "analytics.metric.read");
  return ok(characterPerformanceReconciliationSchema.parse(
    await reconcileCharacterPerformanceFacts(prisma),
  ), { headers: { "cache-control": "no-store" } });
}
