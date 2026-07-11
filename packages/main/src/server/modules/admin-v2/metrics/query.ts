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
import { evaluateMetricCertification, REQUIRED_METRIC_QUALITY_CHECKS } from "./certification";
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

function sourceFactEvidence(dataset: CanonicalMetricDataset, asOf: Date) {
  const summarize = (dates: readonly Date[]) => ({
    count: dates.length,
    latestDataAt: dates.length === 0 ? null : new Date(Math.max(...dates.map((date) => date.getTime()))),
  });
  return new Map([
    ["customer_signup_fact", summarize(dataset.signups.filter((row) => row.eligible && row.occurredAt <= asOf).map((row) => row.occurredAt))],
    ["chat_exchange_fact", summarize(dataset.chatExchanges.filter((row) => row.eligible && row.occurredAt <= asOf).map((row) => row.occurredAt))],
    ["generation_fulfillment_fact", summarize(dataset.generationDeliveries.filter((row) => row.eligible && row.occurredAt <= asOf).map((row) => row.occurredAt))],
    ["subscription_lifecycle_fact", summarize(dataset.subscriptions.filter((row) => row.eligible && row.activeAt <= asOf).map((row) => row.endedAt && row.endedAt <= asOf ? row.endedAt : row.activeAt))],
  ]);
}

function hasEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function validSnapshotData(snapshot: {
  numeratorValue: number | null;
  denominatorValue: number | null;
  value: number | null;
  sampleSize: number;
  matureSampleSize: number;
  immatureSampleSize: number;
  maturity: string;
}): boolean {
  const nullableFinite = (value: number | null) => value === null || Number.isFinite(value);
  return nullableFinite(snapshot.numeratorValue)
    && nullableFinite(snapshot.denominatorValue)
    && nullableFinite(snapshot.value)
    && Number.isInteger(snapshot.sampleSize) && snapshot.sampleSize >= 0
    && Number.isInteger(snapshot.matureSampleSize) && snapshot.matureSampleSize >= 0
    && Number.isInteger(snapshot.immatureSampleSize) && snapshot.immatureSampleSize >= 0
    && ["mature", "immature", "insufficient_data"].includes(snapshot.maturity)
    && (snapshot.numeratorValue === null || snapshot.denominatorValue === null || snapshot.numeratorValue <= snapshot.denominatorValue);
}

async function qualityReport(db: PrismaClient, asOf: Date) {
  const [report, eligibleSignups, eligibleExchanges, eligibleDeliveries, eligibleSubscriptions] = await Promise.all([
    reconcileCanonicalMetricFacts(db, { asOf }),
    db.customerSignupFact.count({ where: { eligible: true, occurredAt: { lte: asOf } } }),
    db.chatExchangeFact.count({ where: { eligible: true, occurredAt: { lte: asOf } } }),
    db.generationFulfillmentFact.count({ where: { eligible: true, occurredAt: { lte: asOf } } }),
    db.subscriptionLifecycleFact.count({ where: { eligible: true, activeAt: { lte: asOf } } }),
  ]);
  const eligibleFactCount = eligibleSignups + eligibleExchanges + eligibleDeliveries + eligibleSubscriptions;
  const freshnessFailed = report.eventLagP95Ms === null || report.eventLagP95Ms > FRESHNESS_SLO_MS;
  const qualityState = report.qualityState === "certified" && !freshnessFailed && eligibleFactCount > 0 ? "certified" as const : "invalid" as const;
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
      { key: "eligible_fact_presence", status: eligibleFactCount > 0 ? "passed" : "failed", observed: eligibleFactCount, threshold: "> 0" },
    ],
  });
}

async function buildCards(input: {
  db: PrismaClient;
  dataset: CanonicalMetricDataset;
  asOf: Date;
  requireMetricSnapshot?: boolean;
}): Promise<MetricCard[]> {
  const evaluation = evaluateCanonicalMetrics(input.dataset, input.asOf);
  const metricKeys = Object.keys(evaluation.metrics);
  const [definitionSnapshots, qualityChecks, metricSnapshots] = await Promise.all([
    input.db.metricDefinitionSnapshot.findMany({
      where: { OR: metricKeys.map((key) => ({ key, version: DEFINITION_BY_KEY.get(key)?.version ?? 1 })) },
    }),
    input.db.dataQualityCheck.findMany({
      where: { checkKey: { in: [...REQUIRED_METRIC_QUALITY_CHECKS] }, checkedAt: { lte: input.asOf } },
      orderBy: { checkedAt: "desc" },
    }),
    input.db.metricSnapshot.findMany({
      where: { metricKey: { in: metricKeys }, asOf: { lte: input.asOf } },
      orderBy: { asOf: "desc" },
    }),
  ]);
  const definitionSnapshotByKey = new Map(definitionSnapshots.map((row) => [`${row.key}@${row.version}`, row]));
  const latestMetricSnapshot = new Map<string, (typeof metricSnapshots)[number]>();
  for (const snapshot of metricSnapshots) {
    const key = `${snapshot.metricKey}@${snapshot.definitionVersion}`;
    if (!latestMetricSnapshot.has(key)) latestMetricSnapshot.set(key, snapshot);
  }
  const sources = sourceFactEvidence(input.dataset, input.asOf);
  return Object.entries(evaluation.metrics).map(([key, result]) => {
    const definition = DEFINITION_BY_KEY.get(key);
    if (!definition) throw new Error(`Missing canonical metric definition for ${key}`);
    const identity = `${definition.key}@${definition.version}`;
    const definitionSnapshot = definitionSnapshotByKey.get(identity);
    const snapshot = latestMetricSnapshot.get(identity);
    const metricQualityChecks = new Map<string, (typeof qualityChecks)[number]>();
    for (const check of qualityChecks) {
      if (metricQualityChecks.has(check.checkKey)) continue;
      if (Array.isArray(check.metricKeys) && check.metricKeys.includes(definition.key)) {
        metricQualityChecks.set(check.checkKey, check);
      }
    }
    const certification = evaluateMetricCertification({
      definition,
      asOf: input.asOf,
      requireMetricSnapshot: input.requireMetricSnapshot,
      evidence: {
        definitionSnapshot: definitionSnapshot ? {
          queryHash: definitionSnapshot.queryHash,
          definitionMatches: canonicalSha256(definitionSnapshot.definition) === canonicalSha256(definition),
          qualityState: definitionSnapshot.qualityState,
          effectiveAt: definitionSnapshot.effectiveAt,
          lastValidatedAt: definitionSnapshot.lastValidatedAt,
          hasEvidence: hasEvidence(definitionSnapshot.validationEvidence),
        } : null,
        qualityChecks: new Map([...metricQualityChecks].map(([checkKey, check]) => [checkKey, {
          status: check.status,
          checkedAt: check.checkedAt,
          hasEvidence: hasEvidence(check.evidence),
        }])),
        metricSnapshot: snapshot ? {
          definitionQueryHash: snapshot.definitionQueryHash,
          qualityState: snapshot.qualityState,
          publicationStatus: snapshot.publicationStatus,
          asOf: snapshot.asOf,
          latestDataAt: snapshot.latestDataAt,
          hasEvidence: hasEvidence(snapshot.qualityEvidence),
          dataValid: validSnapshotData(snapshot),
        } : null,
        sourceFacts: sources,
      },
    });
    const usableSnapshot = certification.decisionUse !== "blocked" ? snapshot : null;
    return {
      key,
      definitionVersion: definition.version,
      publicationStatus: definition.publicationStatus,
      name: definition.name,
      value: usableSnapshot?.value ?? null,
      unit: result.denominator === null ? "users" : "ratio",
      numeratorLabel: definition.numerator,
      denominatorLabel: definition.denominator,
      numeratorValue: usableSnapshot ? usableSnapshot.numeratorValue : result.numerator,
      denominatorValue: usableSnapshot ? usableSnapshot.denominatorValue : result.denominator,
      sampleSize: usableSnapshot ? usableSnapshot.sampleSize : result.sampleSize,
      matureSampleSize: usableSnapshot ? usableSnapshot.matureSampleSize : result.matureSampleSize,
      immatureSampleSize: usableSnapshot ? usableSnapshot.immatureSampleSize : result.immatureSampleSize,
      window: definition.window,
      timezone: "UTC",
      maturity: usableSnapshot ? usableSnapshot.maturity as MetricCard["maturity"] : result.maturity,
      asOf: input.asOf.toISOString(),
      validFrom: definition.validFrom,
      latestDataAt: certification.latestDataAt?.toISOString() ?? null,
      qualityState: certification.qualityState,
      decisionUse: certification.decisionUse,
      qualityEvidence: certification.evidence,
    };
  });
}

async function buildMetricDashboardData(db: PrismaClient, asOf: Date) {
  const rawDataset = await loadCanonicalMetricDataset(db);
  const dataset = filterDatasetFrom(rawDataset, factsValidFrom());
  const liveQuality = await qualityReport(db, asOf);
  const cards = await buildCards({ db, dataset, asOf });
  const quality = cards.every((card) => card.decisionUse === "blocked")
    ? { ...liveQuality, qualityState: "invalid" as const }
    : liveQuality;
  return metricDashboardResponseSchema.parse({
    definitions: CANONICAL_DEFINITIONS,
    cards,
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
  const rawDataset = await loadCanonicalMetricDataset(db);
  const dataset = filterDatasetFrom(rawDataset, factsValidFrom());
  const quality = await qualityReport(db, asOf);
  const windowStart = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1_000);
  await db.$transaction(async (tx) => {
    for (const check of quality.checks) {
      await tx.dataQualityCheck.create({
        data: {
          checkKey: `metrics.${check.key}`,
          status: check.status,
          metricKeys: CANONICAL_DEFINITIONS.map((definition) => definition.key),
          observed: toInputJson({ value: check.observed }),
          threshold: toInputJson({ expression: check.threshold }),
          evidence: toInputJson({ asOf: asOf.toISOString(), observed: check.observed, threshold: check.threshold }),
          windowStart,
          windowEnd: asOf,
          checkedAt: asOf,
        },
      });
    }
  });
  const cards = await buildCards({ db, dataset, asOf, requireMetricSnapshot: false });
  const dashboard = metricDashboardResponseSchema.parse({
    definitions: CANONICAL_DEFINITIONS,
    cards,
    quality,
    asOf: asOf.toISOString(),
    freshness: quality.qualityState === "invalid" ? "degraded" : "fresh",
  });
  await db.$transaction(async (tx) => {
    for (const card of cards) {
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
