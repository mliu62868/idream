import {
  ADMIN_METRIC_REGISTRY,
  metricCardSchema,
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
import { effectivePermissionScope } from "@/server/admin/effective-permissions";
import { canonicalSha256 } from "../shared/canonical-json";
import { toInputJson } from "../shared/prisma-json";
import { evaluateMetricCertification, REQUIRED_METRIC_QUALITY_CHECKS } from "./certification";
import { evaluateCanonicalMetrics, type CanonicalMetricDataset, utcCalendarWeekStart } from "./engine";
import { loadCanonicalMetricDataset, reconcileCanonicalMetricFacts } from "./projector";

const FRESHNESS_SLO_MS = 60 * 60 * 1_000;
const OUTCOME_COMPLETENESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
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

function metricWindowStart(definition: MetricDefinition, asOf: Date) {
  if (definition.key === "north_star.wpcu") return utcCalendarWeekStart(asOf);
  if (["north_star.wscu", "diagnostic.wsr", "guardrail.wscru", "business.wpscu"].includes(definition.key)) {
    return new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1_000);
  }
  return new Date(definition.validFrom);
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

interface MetricQualityCheckRow {
  readonly checkKey: string;
  readonly status: string;
  readonly metricKeys: unknown;
  readonly checkedAt: Date;
  readonly evidence?: unknown;
}

const QUALITY_CHECK_STATUS_PRIORITY: Readonly<Record<string, number>> = {
  passed: 0,
  unavailable: 1,
  rechecking: 2,
  failed: 3,
};

function sourceEventIdFromQualityEvidence(evidence: unknown): string | null {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const sourceEventId = (evidence as Record<string, unknown>).sourceEventId;
  return typeof sourceEventId === "string" ? sourceEventId : null;
}

export function selectQualityChecksForMetric<T extends MetricQualityCheckRow>(
  rows: readonly T[],
  metricKey: string,
): Map<string, T> {
  const relevant = rows.filter((row) => Array.isArray(row.metricKeys) && row.metricKeys.includes(metricKey));
  const latestAggregate = new Map<string, T>();
  for (const row of relevant) {
    if (sourceEventIdFromQualityEvidence(row.evidence)) continue;
    const current = latestAggregate.get(row.checkKey);
    if (!current || row.checkedAt > current.checkedAt) latestAggregate.set(row.checkKey, row);
  }
  const selected = new Map<string, T>();
  for (const row of relevant) {
    if (!sourceEventIdFromQualityEvidence(row.evidence) && latestAggregate.get(row.checkKey) !== row) continue;
    const current = selected.get(row.checkKey);
    const rowPriority = QUALITY_CHECK_STATUS_PRIORITY[row.status] ?? 2;
    const currentPriority = current ? QUALITY_CHECK_STATUS_PRIORITY[current.status] ?? 2 : -1;
    if (!current || rowPriority > currentPriority || (
      rowPriority === currentPriority && row.checkedAt > current.checkedAt
    )) {
      selected.set(row.checkKey, row);
    }
  }
  return selected;
}

async function qualityReport(db: PrismaClient, asOf: Date) {
  const completenessWindowStart = new Date(asOf.getTime() - OUTCOME_COMPLETENESS_WINDOW_MS);
  const [report, eligibleSignups, eligibleExchanges, eligibleDeliveries, eligibleSubscriptions] = await Promise.all([
    reconcileCanonicalMetricFacts(db, { asOf, windowStart: completenessWindowStart }),
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
      { key: "server_outcome_completeness", status: report.incompleteOutcomeCount === 0 ? "passed" : "failed", observed: report.incompleteOutcomeCount, threshold: "= 0" },
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
  const maxQualityCheckAgeMs = Math.max(
    ...metricKeys.map((key) => (DEFINITION_BY_KEY.get(key)?.freshnessSlo.maxAgeSeconds ?? 0) * 1_000),
  );
  const completenessWindowStart = new Date(input.asOf.getTime() - OUTCOME_COMPLETENESS_WINDOW_MS);
  const nonCompletenessChecks = REQUIRED_METRIC_QUALITY_CHECKS.filter(
    (checkKey) => checkKey !== "metrics.server_outcome_completeness",
  );
  const [definitionSnapshots, qualityChecks, metricSnapshots] = await Promise.all([
    input.db.metricDefinitionSnapshot.findMany({
      where: { OR: metricKeys.map((key) => ({ key, version: DEFINITION_BY_KEY.get(key)?.version ?? 1 })) },
    }),
    input.db.dataQualityCheck.findMany({
      where: {
        checkedAt: { lte: input.asOf },
        OR: [
          {
            checkKey: "metrics.server_outcome_completeness",
            windowEnd: { gte: completenessWindowStart },
          },
          {
            checkKey: { in: nonCompletenessChecks },
            checkedAt: { gte: new Date(input.asOf.getTime() - maxQualityCheckAgeMs) },
          },
        ],
      },
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
    const metricQualityChecks = selectQualityChecksForMetric(qualityChecks, definition.key);
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
  const cards = [
    ...await buildCards({ db, dataset, asOf }),
    ...await buildBusinessFactCards(db, asOf),
  ];
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

async function buildBusinessFactCards(db: PrismaClient, asOf: Date): Promise<MetricCard[]> {
  const windowStart = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1_000);
  const usage = await db.aiUsageFact.findMany({
    where: {
      environment: "production",
      dataClass: "customer",
      trustClass: "canonical",
      actorIsInternal: false,
      occurredAt: { gte: windowStart, lte: asOf },
    },
    select: { costMicros: true, occurredAt: true },
  });
  const costDefinition = DEFINITION_BY_KEY.get("cost.provider_variable_7d") as MetricDefinition;
  const marginDefinition = DEFINITION_BY_KEY.get("margin.character_contribution_7d") as MetricDefinition;
  const priced = usage.filter((fact) => fact.costMicros !== null);
  const costMicrosBigInt = priced.reduce((sum, fact) => sum + (fact.costMicros ?? BigInt(0)), BigInt(0));
  const costIsSafeInteger = costMicrosBigInt <= BigInt(Number.MAX_SAFE_INTEGER);
  const hasCompletePricing = usage.length > 0 && priced.length === usage.length && costIsSafeInteger;
  const costMicros = hasCompletePricing ? Number(costMicrosBigInt) : null;
  const latestDataAt = usage.length > 0
    ? new Date(Math.max(...usage.map((fact) => fact.occurredAt.getTime()))).toISOString()
    : null;
  return [
    {
      key: costDefinition.key,
      definitionVersion: costDefinition.version,
      publicationStatus: costDefinition.publicationStatus,
      name: costDefinition.name,
      value: costMicros,
      unit: "micros",
      numeratorLabel: costDefinition.numerator,
      denominatorLabel: costDefinition.denominator,
      numeratorValue: costMicros,
      denominatorValue: null,
      sampleSize: usage.length,
      matureSampleSize: priced.length,
      immatureSampleSize: usage.length - priced.length,
      window: costDefinition.window,
      timezone: "UTC",
      maturity: usage.length === 0 ? "insufficient_data" : hasCompletePricing ? "mature" : "immature",
      asOf: asOf.toISOString(),
      validFrom: costDefinition.validFrom,
      latestDataAt,
      qualityState: hasCompletePricing ? "directional" : "invalid",
      decisionUse: hasCompletePricing ? "directional_only" : "blocked",
      qualityEvidence: [
        `priced_invocations=${priced.length}/${usage.length}`,
        ...(costIsSafeInteger ? [] : ["provider_cost_total_exceeds_safe_numeric_range"]),
        "Cash revenue is not inferred from provider cost.",
      ],
    },
    {
      key: marginDefinition.key,
      definitionVersion: marginDefinition.version,
      publicationStatus: marginDefinition.publicationStatus,
      name: marginDefinition.name,
      value: null,
      unit: "micros",
      numeratorLabel: marginDefinition.numerator,
      denominatorLabel: marginDefinition.denominator,
      numeratorValue: null,
      denominatorValue: null,
      sampleSize: 0,
      matureSampleSize: 0,
      immatureSampleSize: 0,
      window: marginDefinition.window,
      timezone: "UTC",
      maturity: "insufficient_data",
      asOf: asOf.toISOString(),
      validFrom: marginDefinition.validFrom,
      latestDataAt: null,
      qualityState: "invalid",
      decisionUse: "blocked",
      qualityEvidence: ["cash_attribution_authority_unavailable", "Dreamcoin consumption is not cash revenue."],
    },
  ].map((card) => metricCardSchema.parse(card));
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
  const qualityWindowStart = factsValidFrom();
  const completenessWindowStart = new Date(asOf.getTime() - OUTCOME_COMPLETENESS_WINDOW_MS);
  const quarantinedOutcomeTypes = await db.metricProjectionReceipt.findMany({
    where: {
      outcome: "quarantined",
      occurredAt: { gte: completenessWindowStart, lte: asOf },
    },
    select: { eventType: true },
    distinct: ["eventType"],
  });
  const quarantinedEventTypes = new Set(quarantinedOutcomeTypes.map((row) => row.eventType));
  const affectedCompletenessMetrics = CANONICAL_DEFINITIONS
    .filter((definition) => definition.sourceEvents.some((eventType) => quarantinedEventTypes.has(eventType)))
    .map((definition) => definition.key);
  await db.$transaction(async (tx) => {
    for (const check of quality.checks) {
      await tx.dataQualityCheck.create({
        data: {
          checkKey: `metrics.${check.key}`,
          status: check.status,
          metricKeys: check.key === "server_outcome_completeness" && check.status !== "passed"
            ? affectedCompletenessMetrics
            : CANONICAL_DEFINITIONS.map((definition) => definition.key),
          observed: toInputJson({ value: check.observed }),
          threshold: toInputJson({ expression: check.threshold }),
          evidence: toInputJson({ asOf: asOf.toISOString(), observed: check.observed, threshold: check.threshold }),
          windowStart: check.key === "server_outcome_completeness"
            ? completenessWindowStart
            : qualityWindowStart,
          windowEnd: asOf,
          checkedAt: asOf,
        },
      });
    }
  });
  const cards = [
    ...await buildCards({ db, dataset, asOf, requireMetricSnapshot: false }),
    ...await buildBusinessFactCards(db, asOf),
  ];
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
      const windowStart = metricWindowStart(definition, asOf);
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
    const actor = await actorWithPermission(request, "analytics.metric.read");
    const data = await buildMetricDashboardData(prisma, parseAsOf(request));
    const scope = await effectivePermissionScope(actor.id, actor.role, "analytics.metric.read");
    return ok(scope === "technical_metrics"
      ? { ...data, definitions: [], cards: [] }
      : data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}

export async function getMetricQualityReport(request: Request) {
  try {
    await actorWithPermission(request, "analytics.metric.read");
    const data = await qualityReport(prisma, parseAsOf(request));
    return ok(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    throw error;
  }
}

export async function getMetricReconciliationReport(request: Request) {
  try {
    await actorWithPermission(request, "analytics.metric.read");
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
