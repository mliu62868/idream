import {
  ADMIN_METRIC_REGISTRY,
  experimentAnalysisResponseSchema,
  experimentVariantSchema,
  type ExperimentAnalysisResponse,
} from "@idream/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { selectQualityChecksForMetric } from "../metrics/query";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const PRIMARY_METRIC = "relationship.qce_activation.v1" as const;
const SUPPORT_GUARDRAIL = "guardrail.support_contact_rate.v1" as const;
const QUALITY_CHECK_KEYS = [
  "metrics.server_outcome_completeness",
  "metrics.duplicate_effect",
  "metrics.impossible_state",
  "metrics.fixture_internal_leakage",
  "metrics.authoritative_join_coverage",
  "metrics.event_lag_p95",
  "metrics.eligible_fact_presence",
] as const;
const QUALITY_FRESHNESS_MS = 60 * 60 * 1_000;
function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function comparison(control: { outcomeSubjects: number; matureSubjects: number; rate: number | null }, arm: { outcomeSubjects: number; matureSubjects: number; rate: number | null }) {
  if (control.rate === null || arm.rate === null || control.matureSubjects === 0 || arm.matureSubjects === 0) return { interval: null, pValue: null };
  const lift = arm.rate - control.rate;
  const unpooledSe = Math.sqrt((arm.rate * (1 - arm.rate)) / arm.matureSubjects + (control.rate * (1 - control.rate)) / control.matureSubjects);
  const interval: [number, number] = [lift - 1.96 * unpooledSe, lift + 1.96 * unpooledSe];
  const pooled = (arm.outcomeSubjects + control.outcomeSubjects) / (arm.matureSubjects + control.matureSubjects);
  const pooledSe = Math.sqrt(pooled * (1 - pooled) * (1 / arm.matureSubjects + 1 / control.matureSubjects));
  const pValue = pooledSe === 0 ? (lift === 0 ? 1 : 0) : 2 * (1 - normalCdf(Math.abs(lift / pooledSe)));
  return { interval, pValue: Math.max(0, Math.min(1, pValue)) };
}

export class ExperimentAnalysisError extends Error {
  constructor(
    readonly code: "experiment_not_found" | "unsupported_metric_config" | "invalid_variant_config",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function record(value: Prisma.JsonValue): Record<string, Prisma.JsonValue | undefined> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

export async function analyzeExperiment(
  db: PrismaClient,
  experimentId: string,
  asOf = new Date(),
): Promise<ExperimentAnalysisResponse> {
  const experiment = await db.experimentDefinition.findUnique({ where: { id: experimentId } });
  if (!experiment) {
    throw new ExperimentAnalysisError("experiment_not_found", "Experiment definition was not found", 404);
  }
  const variantsResult = experimentVariantSchema.array().safeParse(experiment.variants);
  if (!variantsResult.success || variantsResult.data.length < 2) {
    throw new ExperimentAnalysisError("invalid_variant_config", "Experiment analysis requires at least two valid variants", 409);
  }
  const metrics = record(experiment.metrics);
  if (metrics.primary !== PRIMARY_METRIC) {
    throw new ExperimentAnalysisError(
      "unsupported_metric_config",
      `Only ${PRIMARY_METRIC} is currently certified for experiment analysis`,
      409,
    );
  }
  const controlVariant = typeof metrics.controlVariant === "string"
    ? metrics.controlVariant
    : variantsResult.data[0].key;
  if (!variantsResult.data.some((variant) => variant.key === controlVariant)) {
    throw new ExperimentAnalysisError("invalid_variant_config", "controlVariant must name a configured variant", 409);
  }
  const minimumMaturePerArm = typeof metrics.minimumMaturePerArm === "number" && Number.isInteger(metrics.minimumMaturePerArm)
    ? Math.max(20, metrics.minimumMaturePerArm)
    : 100;
  const guardrails = Array.isArray(metrics.guardrails) && metrics.guardrails.length > 0
    ? metrics.guardrails.filter((value): value is { metricKey: string; maxAbsoluteRegression: number } => {
        const item = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        return typeof item.metricKey === "string" && item.metricKey !== PRIMARY_METRIC && typeof item.maxAbsoluteRegression === "number" && item.maxAbsoluteRegression >= 0 && item.maxAbsoluteRegression <= 1;
      })
    : [{ metricKey: SUPPORT_GUARDRAIL, maxAbsoluteRegression: 0.02 }];
  const requiredMetricKeys = [PRIMARY_METRIC, ...new Set(guardrails.map((guardrail) => guardrail.metricKey))];

  const [assignments, rawExposureFacts, metricDefinitions, qualityChecks] = await Promise.all([
    db.experimentAssignment.findMany({ where: { experimentId } }),
    db.experimentExposureFact.findMany({
      where: {
        experimentId,
        eligible: true,
        environment: "production",
        dataClass: "customer",
        trustClass: { in: ["typed_client", "canonical"] },
        occurredAt: { lte: asOf },
      },
      orderBy: { occurredAt: "asc" },
    }),
    db.metricDefinitionSnapshot.findMany({
      where: { OR: requiredMetricKeys.flatMap((key) => {
        const definition = ADMIN_METRIC_REGISTRY.find((candidate) => candidate.key === key);
        return definition ? [{ key, version: definition.version }] : [];
      }) },
    }),
    db.dataQualityCheck.findMany({
      where: { checkKey: { in: [...QUALITY_CHECK_KEYS] }, checkedAt: { lte: asOf, gte: new Date(asOf.getTime() - QUALITY_FRESHNESS_MS) } },
      orderBy: { checkedAt: "desc" },
    }),
  ]);
  const definitionByKey = new Map(metricDefinitions.map((definition) => [definition.key, definition]));
  const certifiedMetric = (metricKey: string) => {
    const registryDefinition = ADMIN_METRIC_REGISTRY.find((definition) => definition.key === metricKey);
    const definition = definitionByKey.get(metricKey);
    const definitionEvidence = definition?.validationEvidence;
    const selectedChecks = selectQualityChecksForMetric(qualityChecks, metricKey);
    return Boolean(registryDefinition && definition
      && definition.version === registryDefinition.version
      && definition.qualityState === "certified"
      && definition.lastValidatedAt !== null
      && definition.effectiveAt <= asOf
      && definition.queryHash === registryDefinition.queryHash
      && canonicalSha256(definition.definition) === canonicalSha256(registryDefinition)
      && ((Array.isArray(definitionEvidence) && definitionEvidence.length > 0)
        || (definitionEvidence !== null && typeof definitionEvidence === "object" && Object.keys(definitionEvidence).length > 0))
      && QUALITY_CHECK_KEYS.every((checkKey) => {
        const check = selectedChecks.get(checkKey);
        return check?.status === "passed"
          && check.evidence !== null
          && typeof check.evidence === "object"
          && Object.keys(check.evidence).length > 0;
      }));
  };
  const certifiedMetricGate = certifiedMetric(PRIMARY_METRIC);
  const allMetricCertificationPassed = requiredMetricKeys.every(certifiedMetric);
  const assignmentKeys = new Set(assignments.map((assignment) => [
    assignment.experimentVersion,
    assignment.assignmentVersion,
    assignment.subjectType,
    assignment.subjectId,
    assignment.variant,
  ].join("\u0000")));
  const exposureFacts = rawExposureFacts.filter((exposure) => assignmentKeys.has([
    exposure.experimentVersion,
    exposure.assignmentVersion,
    exposure.subjectType,
    exposure.subjectId,
    exposure.variant,
  ].join("\u0000")));
  const assignmentJoinGaps = rawExposureFacts.length - exposureFacts.length;
  const firstExposureBySubject = new Map<string, (typeof exposureFacts)[number]>();
  for (const exposure of exposureFacts) {
    const key = `${exposure.subjectType}:${exposure.subjectId}`;
    if (!firstExposureBySubject.has(key)) firstExposureBySubject.set(key, exposure);
  }
  const matureUserExposures = [...firstExposureBySubject.values()].filter(
    (exposure) => exposure.subjectType === "user" && exposure.occurredAt.getTime() + WINDOW_MS <= asOf.getTime(),
  );
  const userIds = [...new Set(matureUserExposures.map((exposure) => exposure.subjectId))];
  const earliest = matureUserExposures.reduce<Date | null>(
    (current, exposure) => current === null || exposure.occurredAt < current ? exposure.occurredAt : current,
    null,
  );
  const exchanges = earliest === null || userIds.length === 0
    ? []
    : await db.chatExchangeFact.findMany({
      where: {
        userId: { in: userIds },
        eligible: true,
        environment: "production",
        dataClass: "customer",
        trustClass: { in: ["canonical", "typed_client"] },
        occurredAt: { gte: earliest, lte: asOf },
      },
      select: { userId: true, engagementSessionId: true, exchangeId: true, occurredAt: true },
    });
  const [supportRequests, supportEvents] = earliest === null || userIds.length === 0
    ? [[], []] as const
    : await Promise.all([
        db.supportRequest.findMany({
          where: { userId: { in: userIds }, createdAt: { gte: earliest, lte: asOf } },
          select: { id: true, userId: true, createdAt: true },
        }),
        db.analyticsEvent.findMany({
          where: {
            name: "support.request.submitted.v2",
            userId: { in: userIds },
            occurredAt: { gte: earliest, lte: asOf },
            environment: "production",
            dataClass: "customer",
            trustClass: "canonical",
          },
          select: { sourceEventId: true, userId: true, occurredAt: true },
        }),
      ]);
  const canonicalSupportIds = new Set(supportEvents.flatMap((event) =>
    event.sourceEventId?.startsWith("support_request:") ? [event.sourceEventId.slice("support_request:".length)] : [],
  ));
  const missingSupportOutcomeEvents = supportRequests.filter((request) => !canonicalSupportIds.has(request.id)).length;

  const outcomeSubjects = new Set<string>();
  const supportContactSubjects = new Set<string>();
  for (const exposure of matureUserExposures) {
    const windowEnd = new Date(exposure.occurredAt.getTime() + WINDOW_MS);
    const sessionExchanges = new Map<string, Set<string>>();
    for (const exchange of exchanges) {
      if (
        exchange.userId !== exposure.subjectId ||
        exchange.occurredAt < exposure.occurredAt ||
        exchange.occurredAt >= windowEnd
      ) continue;
      const ids = sessionExchanges.get(exchange.engagementSessionId) ?? new Set<string>();
      ids.add(exchange.exchangeId);
      sessionExchanges.set(exchange.engagementSessionId, ids);
    }
    if ([...sessionExchanges.values()].some((ids) => ids.size >= 5)) {
      outcomeSubjects.add(`${exposure.subjectType}:${exposure.subjectId}`);
    }
    if (supportRequests.some((request) =>
      request.userId === exposure.subjectId &&
      canonicalSupportIds.has(request.id) &&
      request.createdAt >= exposure.occurredAt &&
      request.createdAt < windowEnd
    )) {
      supportContactSubjects.add(`${exposure.subjectType}:${exposure.subjectId}`);
    }
  }

  const baseArms = variantsResult.data.map((variant) => {
    const exposed = [...firstExposureBySubject.values()].filter((row) => row.variant === variant.key);
    const mature = matureUserExposures.filter((row) => row.variant === variant.key);
    const outcomes = mature.filter((row) => outcomeSubjects.has(`${row.subjectType}:${row.subjectId}`)).length;
    return {
      variant: variant.key,
      assignedSubjects: assignments.filter((row) => row.variant === variant.key).length,
      exposedSubjects: exposed.length,
      matureSubjects: mature.length,
      outcomeSubjects: outcomes,
      rate: mature.length > 0 ? outcomes / mature.length : null,
    };
  });
  const controlRate = baseArms.find((arm) => arm.variant === controlVariant)?.rate ?? null;
  const control = baseArms.find((arm) => arm.variant === controlVariant);
  const arms = baseArms.map((arm) => {
    const stats = control && arm.variant !== controlVariant ? comparison(control, arm) : arm.rate === null ? { interval: null, pValue: null } : { interval: [0, 0] as [number, number], pValue: 1 };
    return {
      ...arm,
      absoluteLiftVsControl: arm.rate === null || controlRate === null ? null : arm.rate - controlRate,
      confidenceInterval95: stats.interval,
      pValueVsControl: stats.pValue,
    };
  });
  const exposedCount = [...firstExposureBySubject.values()].length;
  const matureCount = matureUserExposures.length;
  const maturity = exposedCount === 0
    ? "insufficient_data" as const
    : matureCount === 0
      ? "immature" as const
      : "mature" as const;
  const allArmsMature = arms.length >= 2 && arms.every((arm) => arm.matureSubjects >= minimumMaturePerArm);
  const guardrailAnalyses = guardrails.map((guardrail) => {
    if (guardrail.metricKey !== SUPPORT_GUARDRAIL) {
      return {
        metricKey: guardrail.metricKey,
        maxAbsoluteRegression: guardrail.maxAbsoluteRegression,
        controlRate: null,
        worstVariantRate: null,
        observedRegression: null,
        state: "blocked" as const,
        evidence: ["unsupported_guardrail_metric"],
      };
    }
    const rateByVariant = new Map(variantsResult.data.map((variant) => {
      const mature = matureUserExposures.filter((exposure) => exposure.variant === variant.key);
      const contacts = mature.filter((exposure) => supportContactSubjects.has(`${exposure.subjectType}:${exposure.subjectId}`)).length;
      return [variant.key, mature.length > 0 ? contacts / mature.length : null] as const;
    }));
    const supportControlRate = rateByVariant.get(controlVariant) ?? null;
    const variantRates = [...rateByVariant.entries()]
      .filter(([variant, rate]) => variant !== controlVariant && rate !== null)
      .map(([, rate]) => rate as number);
    const worstVariantRate = variantRates.length > 0 ? Math.max(...variantRates) : null;
    const observedRegression = supportControlRate === null || worstVariantRate === null
      ? null
      : worstVariantRate - supportControlRate;
    const blockedReasons = [
      ...(!allArmsMature ? ["guardrail_cohort_not_mature"] : []),
      ...(!certifiedMetric(guardrail.metricKey) ? ["guardrail_metric_not_certified"] : []),
      ...(missingSupportOutcomeEvents > 0 ? [`missing_canonical_support_outcomes:${missingSupportOutcomeEvents}`] : []),
      ...(observedRegression === null ? ["guardrail_rate_unavailable"] : []),
    ];
    return {
      metricKey: guardrail.metricKey,
      maxAbsoluteRegression: guardrail.maxAbsoluteRegression,
      controlRate: supportControlRate,
      worstVariantRate,
      observedRegression,
      state: blockedReasons.length > 0
        ? "blocked" as const
        : observedRegression! > guardrail.maxAbsoluteRegression
          ? "failed" as const
          : "passed" as const,
      evidence: blockedReasons.length > 0
        ? blockedReasons
        : [
            `canonical_support_outcome_join_gaps:0`,
            `observed_regression:${observedRegression}`,
            `maximum_allowed_regression:${guardrail.maxAbsoluteRegression}`,
          ],
    };
  });
  const guardrailState = guardrailAnalyses.some((guardrail) => guardrail.state === "failed")
    ? "failed" as const
    : guardrailAnalyses.every((guardrail) => guardrail.state === "passed")
      ? "passed" as const
      : "blocked" as const;
  const qualityState = matureCount === 0 || assignmentJoinGaps > 0 || missingSupportOutcomeEvents > 0
    ? "invalid" as const
    : allArmsMature && allMetricCertificationPassed
      ? "certified" as const
      : "directional" as const;
  const comparisons = arms.filter((arm) => arm.variant !== controlVariant);
  const significance = !allArmsMature ? "unavailable" as const : comparisons.some((arm) => (arm.pValueVsControl ?? 1) < 0.05) ? "significant" as const : "not_significant" as const;
  const decisionUse = qualityState === "certified" && guardrailState === "passed"
    ? "eligible" as const
    : qualityState === "directional"
      ? "directional_only" as const
      : "blocked" as const;
  return experimentAnalysisResponseSchema.parse({
    experimentId: experiment.id,
    experimentKey: experiment.key,
    experimentVersion: experiment.version,
    status: experiment.status,
    primaryMetric: PRIMARY_METRIC,
    controlVariant,
    window: "7d_after_first_exposure",
    asOf: asOf.toISOString(),
    maturity,
    qualityState,
    decisionUse,
    significance,
    guardrailState,
    guardrails: guardrailAnalyses,
    minimumMaturePerArm,
    qualityEvidence: [
      "denominator contains unique user subjects with a real eligible exposure and a fully matured 7-day window",
      "outcome requires at least five distinct eligible exchanges in one engagement session after first exposure",
      "anonymous exposures remain visible in exposedSubjects but are excluded from user QCE denominator",
      `assignment/exposure join gaps: ${assignmentJoinGaps}; any gap invalidates decision use`,
      `primary metric certification: ${certifiedMetricGate ? "passed" : "blocked"}; requires the exact immutable registry snapshot and seven fresh evidenced quality gates`,
      `all metric certification: ${allMetricCertificationPassed ? "passed" : "blocked"}; independent guardrails configured: ${guardrails.length}`,
      `canonical support outcome join gaps: ${missingSupportOutcomeEvents}`,
      `decision eligibility requires at least ${minimumMaturePerArm} mature exposed user subjects in every arm`,
      "95% intervals and two-sided p-values use a two-proportion normal approximation; production decisions remain blocked until all configured guardrails pass",
    ],
    arms,
  });
}

export async function getExperimentAnalysis(request: Request, experimentId: string) {
  await actorWithPermission(request, "experiment.manage");
  const query = queryParams(request, "GET /api/v2/admin/experiments/:id/analysis");
  const asOf = query.asOf ? new Date(query.asOf) : new Date();
  try {
    return ok(await analyzeExperiment(prisma, experimentId, asOf), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ExperimentAnalysisError) {
      if (error.status === 404) throw Errors.notFound(error.message, { code: error.code });
      throw Errors.conflict(error.message, { code: error.code });
    }
    throw error;
  }
}
