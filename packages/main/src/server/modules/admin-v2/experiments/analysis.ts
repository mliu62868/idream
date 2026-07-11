import {
  experimentAnalysisResponseSchema,
  experimentVariantSchema,
  type ExperimentAnalysisResponse,
} from "@idream/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const PRIMARY_METRIC = "relationship.qce_activation.v1" as const;

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

  const [assignments, exposureFacts] = await Promise.all([
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
  ]);
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
        occurredAt: { gte: earliest, lte: asOf },
      },
      select: { userId: true, engagementSessionId: true, exchangeId: true, occurredAt: true },
    });

  const outcomeSubjects = new Set<string>();
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
  const arms = baseArms.map((arm) => ({
    ...arm,
    absoluteLiftVsControl: arm.rate === null || controlRate === null ? null : arm.rate - controlRate,
  }));
  const exposedCount = [...firstExposureBySubject.values()].length;
  const matureCount = matureUserExposures.length;
  const maturity = exposedCount === 0
    ? "insufficient_data" as const
    : matureCount === 0
      ? "immature" as const
      : "mature" as const;
  const qualityState = matureCount > 0 ? "directional" as const : "invalid" as const;
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
    decisionUse: qualityState === "directional" ? "directional_only" : "blocked",
    qualityEvidence: [
      "denominator contains unique user subjects with a real eligible exposure and a fully matured 7-day window",
      "outcome requires at least five distinct eligible exchanges in one engagement session after first exposure",
      "anonymous exposures remain visible in exposedSubjects but are excluded from user QCE denominator",
    ],
    arms,
  });
}

export async function getExperimentAnalysis(request: Request, experimentId: string) {
  await actorWithPermission(request, "experiment.manage");
  const rawAsOf = new URL(request.url).searchParams.get("asOf");
  const asOf = rawAsOf ? new Date(rawAsOf) : new Date();
  if (Number.isNaN(asOf.getTime())) throw Errors.badRequest("asOf must be an ISO timestamp");
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
