import {
  ADMIN_METRIC_REGISTRY,
  metricDashboardResponseSchema,
  metricQualityReportSchema,
  metricReconciliationReportSchema,
  type MetricCard,
  type MetricDefinition,
} from "@idream/shared/admin";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { AppError, Errors } from "@/server/lib/errors";
import { fail, ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { evaluateCanonicalMetrics, type CanonicalMetricDataset } from "./engine";
import { loadCanonicalMetricDataset, reconcileCanonicalMetricFacts } from "./projector";

const FRESHNESS_SLO_MS = 60 * 60 * 1_000;
const CANONICAL_DEFINITIONS = ADMIN_METRIC_REGISTRY.filter((definition) =>
  !definition.key.startsWith("legacy.") && definition.key !== "flag_monitoring.exposure",
);
const DEFINITION_BY_KEY = new Map(CANONICAL_DEFINITIONS.map((definition) => [definition.key, definition]));

function parseAsOf(request: Request): Date {
  const raw = new URL(request.url).searchParams.get("asOf");
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw Errors.badRequest("asOf must be an ISO timestamp");
  return parsed;
}

function factsValidFrom(): Date {
  return new Date(Math.min(...CANONICAL_DEFINITIONS.map((definition) => new Date(definition.validFrom).getTime())));
}

function filterDatasetFrom(dataset: CanonicalMetricDataset, validFrom: Date): CanonicalMetricDataset {
  return {
    signups: dataset.signups.filter((row) => row.occurredAt >= validFrom),
    chatExchanges: dataset.chatExchanges.filter((row) => row.occurredAt >= validFrom),
    generationDeliveries: dataset.generationDeliveries.filter((row) => row.occurredAt >= validFrom),
    subscriptions: dataset.subscriptions.filter((row) => row.activeAt >= validFrom),
  };
}

function latestDataAt(dataset: CanonicalMetricDataset): Date | null {
  const timestamps = [
    ...dataset.signups.map((row) => row.occurredAt.getTime()),
    ...dataset.chatExchanges.map((row) => row.occurredAt.getTime()),
    ...dataset.generationDeliveries.map((row) => row.occurredAt.getTime()),
    ...dataset.subscriptions.map((row) => Math.max(row.activeAt.getTime(), row.endedAt?.getTime() ?? 0)),
  ];
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
}

async function qualityReport(db: PrismaClient, asOf: Date) {
  const report = await reconcileCanonicalMetricFacts(db, { asOf });
  const freshnessFailed = report.eventLagP95Ms !== null && report.eventLagP95Ms > FRESHNESS_SLO_MS;
  const qualityState = report.qualityState === "certified" && !freshnessFailed ? "certified" as const : "invalid" as const;
  return metricQualityReportSchema.parse({
    ...report,
    qualityState,
    asOf: asOf.toISOString(),
    freshnessSloMs: FRESHNESS_SLO_MS,
    checks: [
      { key: "duplicate_effect", status: report.duplicateEffectCount === 0 ? "passed" : "failed", observed: report.duplicateEffectCount, threshold: "= 0" },
      { key: "impossible_state", status: report.impossibleStateCount === 0 ? "passed" : "failed", observed: report.impossibleStateCount, threshold: "= 0" },
      { key: "fixture_internal_leakage", status: report.fixtureInternalLeakageCount === 0 ? "passed" : "failed", observed: report.fixtureInternalLeakageCount, threshold: "= 0" },
      { key: "authoritative_join_coverage", status: report.joinCoverage >= 0.99 ? "passed" : "failed", observed: report.joinCoverage, threshold: ">= 0.99" },
      {
        key: "event_lag_p95",
        status: report.eventLagP95Ms === null ? "unavailable" : freshnessFailed ? "failed" : "passed",
        observed: report.eventLagP95Ms,
        threshold: `<= ${FRESHNESS_SLO_MS}ms`,
      },
    ],
  });
}

function buildCards(input: {
  dataset: CanonicalMetricDataset;
  asOf: Date;
  quality: Awaited<ReturnType<typeof qualityReport>>;
}): MetricCard[] {
  const evaluation = evaluateCanonicalMetrics(input.dataset, input.asOf);
  const latest = latestDataAt(input.dataset);
  return Object.entries(evaluation.metrics).map(([key, result]) => {
    const definition = DEFINITION_BY_KEY.get(key);
    if (!definition) throw new Error(`Missing canonical metric definition for ${key}`);
    const failedClosed = input.quality.qualityState === "invalid";
    const qualityState = failedClosed ? "invalid" as const : definition.qualityState;
    const decisionUse = failedClosed
      ? "blocked" as const
      : qualityState === "certified"
        ? "allowed" as const
        : qualityState === "directional"
          ? "directional_only" as const
          : "blocked" as const;
    const qualityEvidence = failedClosed
      ? input.quality.checks.filter((check) => check.status === "failed").map((check) => `${check.key}: ${check.observed} (${check.threshold})`)
      : ["canonical-metrics-golden-dataset-v1", "all required data-quality gates passed"];
    return {
      key,
      definitionVersion: definition.version,
      publicationStatus: definition.publicationStatus,
      name: definition.name,
      value: failedClosed ? null : result.value,
      unit: result.denominator === null ? "users" : "ratio",
      numeratorLabel: definition.numerator,
      denominatorLabel: definition.denominator,
      numeratorValue: result.numerator,
      denominatorValue: result.denominator,
      sampleSize: result.sampleSize,
      matureSampleSize: result.matureSampleSize,
      immatureSampleSize: result.immatureSampleSize,
      window: definition.window,
      timezone: "UTC",
      maturity: result.maturity,
      asOf: input.asOf.toISOString(),
      validFrom: definition.validFrom,
      latestDataAt: latest?.toISOString() ?? null,
      qualityState,
      decisionUse,
      qualityEvidence,
    };
  });
}

async function buildMetricDashboardData(db: PrismaClient, asOf: Date) {
  const rawDataset = await loadCanonicalMetricDataset(db);
  const dataset = filterDatasetFrom(rawDataset, factsValidFrom());
  const quality = await qualityReport(db, asOf);
  return metricDashboardResponseSchema.parse({
    definitions: CANONICAL_DEFINITIONS,
    cards: buildCards({ dataset, asOf, quality }),
    quality,
    asOf: asOf.toISOString(),
    freshness: quality.qualityState === "invalid"
      ? "degraded"
      : quality.eventLagP95Ms !== null && quality.eventLagP95Ms > FRESHNESS_SLO_MS
        ? "stale"
        : "fresh",
  });
}

export async function publishMetricRegistrySnapshots(db: PrismaClient) {
  let created = 0;
  let existingCount = 0;
  for (const definition of ADMIN_METRIC_REGISTRY) {
    const existing = await db.metricDefinitionSnapshot.findUnique({
      where: { key_version: { key: definition.key, version: definition.version } },
    });
    if (existing) {
      if (existing.queryHash !== definition.queryHash || canonicalSha256(existing.definition) !== canonicalSha256(definition)) {
        throw new Error(`Published metric definition is immutable: ${definition.key}@${definition.version}`);
      }
      existingCount += 1;
      continue;
    }
    await db.metricDefinitionSnapshot.create({
      data: {
        key: definition.key,
        version: definition.version,
        definition: toInputJson(definition),
        queryHash: definition.queryHash,
        qualityState: definition.qualityState,
        effectiveAt: new Date(definition.effectiveAt),
        lastValidatedAt: definition.lastValidatedAt ? new Date(definition.lastValidatedAt) : null,
        validationEvidence: toInputJson(definition.validationEvidence),
      },
    });
    created += 1;
  }
  return { created, existing: existingCount };
}

export async function materializeMetricSnapshots(db: PrismaClient, asOf = new Date()) {
  await publishMetricRegistrySnapshots(db);
  const dashboard = await buildMetricDashboardData(db, asOf);
  const windowStart = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1_000);
  await db.$transaction(async (tx) => {
    for (const check of dashboard.quality.checks) {
      await tx.dataQualityCheck.create({
        data: {
          checkKey: `metrics.${check.key}`,
          status: check.status,
          metricKeys: CANONICAL_DEFINITIONS.map((definition) => definition.key),
          observed: toInputJson({ value: check.observed }),
          threshold: toInputJson({ expression: check.threshold }),
          evidence: toInputJson({ asOf: dashboard.asOf }),
          windowStart,
          windowEnd: asOf,
          checkedAt: asOf,
        },
      });
    }
    for (const card of dashboard.cards) {
      const definition = DEFINITION_BY_KEY.get(card.key) as MetricDefinition;
      await tx.metricSnapshot.upsert({
        where: {
          metricKey_definitionVersion_windowStart_windowEnd_asOf: {
            metricKey: card.key,
            definitionVersion: card.definitionVersion,
            windowStart,
            windowEnd: asOf,
            asOf,
          },
        },
        create: {
          metricKey: card.key,
          definitionVersion: card.definitionVersion,
          windowStart,
          windowEnd: asOf,
          asOf,
          numeratorValue: card.numeratorValue,
          denominatorValue: card.denominatorValue,
          value: typeof card.value === "number" ? card.value : null,
          sampleSize: card.sampleSize,
          matureSampleSize: card.matureSampleSize,
          immatureSampleSize: card.immatureSampleSize,
          maturity: card.maturity,
          qualityState: card.qualityState,
          publicationStatus: card.publicationStatus,
          latestDataAt: card.latestDataAt ? new Date(card.latestDataAt) : null,
          definitionQueryHash: definition.queryHash,
          qualityEvidence: toInputJson(card.qualityEvidence),
        },
        update: {
          numeratorValue: card.numeratorValue,
          denominatorValue: card.denominatorValue,
          value: typeof card.value === "number" ? card.value : null,
          sampleSize: card.sampleSize,
          matureSampleSize: card.matureSampleSize,
          immatureSampleSize: card.immatureSampleSize,
          maturity: card.maturity,
          qualityState: card.qualityState,
          latestDataAt: card.latestDataAt ? new Date(card.latestDataAt) : null,
          qualityEvidence: toInputJson(card.qualityEvidence),
        },
      });
    }
  });
  return dashboard;
}

export async function getMetricDashboard(request: Request) {
  try {
    await actorWithPermission(request, "analytics.export");
    const data = await buildMetricDashboardData(prisma, parseAsOf(request));
    return ok(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}

export async function getMetricQualityReport(request: Request) {
  try {
    await actorWithPermission(request, "analytics.export");
    const data = await qualityReport(prisma, parseAsOf(request));
    return ok(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}

export async function getMetricReconciliationReport(request: Request) {
  try {
    await actorWithPermission(request, "analytics.export");
    const asOf = parseAsOf(request);
    const [quality, recentBackfills] = await Promise.all([
      qualityReport(prisma, asOf),
      prisma.metricBackfillRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    ]);
    const data = metricReconciliationReportSchema.parse({
      asOf: asOf.toISOString(),
      quality,
      recentBackfills: recentBackfills.map((run) => ({
        runId: run.id,
        source: run.source,
        status: run.status,
        dryRun: run.dryRun,
        cursor: run.cursor,
        scannedCount: run.scannedCount,
        appliedCount: run.appliedCount,
        skippedCount: run.skippedCount,
        mismatchCount: run.mismatchCount,
        coverage: run.coverage,
        validFrom: run.validFrom?.toISOString() ?? null,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
      })),
    });
    return ok(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}
