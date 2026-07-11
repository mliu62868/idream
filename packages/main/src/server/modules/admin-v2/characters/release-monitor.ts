import type { Prisma, PrismaClient } from "@prisma/client";
import { toInputJson } from "../shared/prisma-json";

type MonitorWindow = "24h" | "72h";

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function evaluateRouteQualification(input: {
  readonly qualification: {
    readonly result: string;
    readonly sampleCount: number;
    readonly identityMatch: number;
    readonly policyVersion: string;
    readonly expiresAt: Date | null;
    readonly evidence: Prisma.JsonValue;
  } | null;
  readonly currentPolicyVersion: string;
  readonly currentEvaluatorVersion: string;
  readonly now: Date;
}) {
  const qualification = input.qualification;
  if (!qualification) return { state: "unqualified" as const, reason: "missing_qualification" };
  if (qualification.expiresAt && qualification.expiresAt.getTime() <= input.now.getTime()) {
    return { state: "expired" as const, reason: "qualification_expired" };
  }
  if (qualification.policyVersion !== input.currentPolicyVersion) {
    return { state: "stale" as const, reason: "policy_version_changed" };
  }
  const evaluatorVersion = record(qualification.evidence).evaluatorVersion;
  if (evaluatorVersion !== input.currentEvaluatorVersion) {
    return { state: "stale" as const, reason: "evaluator_version_changed" };
  }
  if (
    qualification.result !== "qualified" ||
    qualification.sampleCount < 40 ||
    qualification.identityMatch < 0.9
  ) {
    return { state: "unqualified" as const, reason: "qualification_threshold_failed" };
  }
  return { state: "qualified" as const, reason: null };
}

export async function dispatchStaleReleaseRoutes(
  db: PrismaClient,
  input: {
    readonly currentPolicyVersion: string;
    readonly currentEvaluatorVersion: string;
    readonly now?: Date;
    readonly limit?: number;
    readonly releaseIds?: readonly string[];
  },
) {
  const now = input.now ?? new Date();
  const releases = await db.characterRelease.findMany({
    where: {
      status: "published",
      readiness: { not: "stale" },
      ...(input.releaseIds ? { id: { in: [...input.releaseIds] } } : {}),
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: Math.min(500, Math.max(1, input.limit ?? 100)),
  });
  let stale = 0;
  for (const release of releases) {
    const routeFingerprint = record(release.generationProvenance).routeFingerprint;
    const qualification = typeof routeFingerprint === "string"
      ? await db.generationRouteQualification.findFirst({
          where: { routeFingerprint },
          orderBy: { evaluatedAt: "desc" },
        })
      : null;
    const effective = evaluateRouteQualification({
      qualification,
      currentPolicyVersion: input.currentPolicyVersion,
      currentEvaluatorVersion: input.currentEvaluatorVersion,
      now,
    });
    if (effective.state === "qualified") continue;
    const project = await db.characterProject.findUnique({ where: { id: release.projectId } });
    if (!project) continue;
    await db.$transaction(async (tx) => {
      const changed = await tx.characterRelease.updateMany({
        where: { id: release.id, version: release.version, readiness: { not: "stale" } },
        data: { readiness: "stale", version: { increment: 1 } },
      });
      if (changed.count !== 1) return;
      await tx.characterReleaseEvent.create({
        data: {
          releaseId: release.id,
          characterId: project.characterId,
          type: "generation_route_qualification_stale",
          reason: effective.reason,
          fromState: toInputJson({ readiness: release.readiness, routeFingerprint }),
          toState: toInputJson({ readiness: "stale", effectiveQualification: effective.state }),
          evidence: toInputJson({
            qualificationId: qualification?.id ?? null,
            historicalResult: qualification?.result ?? null,
            currentPolicyVersion: input.currentPolicyVersion,
            currentEvaluatorVersion: input.currentEvaluatorVersion,
          }),
          occurredAt: now,
        },
      });
      await tx.releaseMonitor.upsert({
        where: { releaseId_window: { releaseId: release.id, window: "route_qualification" } },
        create: {
          releaseId: release.id,
          window: "route_qualification",
          status: "action_required",
          baseline: {},
          observed: toInputJson({ effectiveQualification: effective.state, reason: effective.reason }),
          verification: toInputJson({ servingChanged: false, checkedAt: now.toISOString() }),
          startedAt: now,
        },
        update: {
          status: "action_required",
          observed: toInputJson({ effectiveQualification: effective.state, reason: effective.reason }),
          verification: toInputJson({ servingChanged: false, checkedAt: now.toISOString() }),
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "character.release.qualification_stale.v2",
          aggregateType: "character_release",
          aggregateId: release.id,
          payload: toInputJson({
            releaseId: release.id,
            characterId: project.characterId,
            effectiveQualification: effective.state,
            reason: effective.reason,
            occurredAt: now.toISOString(),
          }),
        },
      });
      stale += 1;
    });
  }
  return { examined: releases.length, stale };
}

function windowMs(window: MonitorWindow): number {
  return window === "24h" ? 24 * 60 * 60 * 1_000 : 72 * 60 * 60 * 1_000;
}

export async function collectReleaseMonitorFacts(
  db: PrismaClient,
  input: { readonly releaseId: string; readonly window: MonitorWindow; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const release = await db.characterRelease.findUnique({ where: { id: input.releaseId } });
  if (!release?.publishedAt) throw new Error("published Release is required for monitoring");
  const windowEnd = new Date(release.publishedAt.getTime() + windowMs(input.window));
  const observationEnd = now < windowEnd ? now : windowEnd;
  const [exchanges, generations] = await Promise.all([
    db.chatExchangeFact.findMany({
      where: {
        characterReleaseId: release.id,
        eligible: true,
        occurredAt: { gte: release.publishedAt, lte: observationEnd },
      },
      select: { userId: true, engagementSessionId: true, occurredAt: true },
    }),
    db.generationFulfillmentFact.findMany({
      where: {
        characterReleaseId: release.id,
        eligible: true,
        occurredAt: { gte: release.publishedAt, lte: observationEnd },
      },
      select: { outcome: true, deliveredOutputCount: true, expectedOutputCount: true, occurredAt: true },
    }),
  ]);
  const mature = now.getTime() >= windowEnd.getTime();
  const failedGenerations = generations.filter((row) => row.outcome !== "succeeded").length;
  const generationFailureRate = generations.length > 0 ? failedGenerations / generations.length : null;
  const recommendation = !mature
    ? "continue_monitoring"
    : generations.length >= 10 && (generationFailureRate ?? 0) > 0.2
      ? "rollback_review"
      : exchanges.length === 0
        ? "investigate_no_chat_usage"
        : "keep";
  const latestObservedAt = [...exchanges, ...generations]
    .map((row) => row.occurredAt)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  const observed = {
    exchangeCount: exchanges.length,
    uniqueUsers: new Set(exchanges.map((row) => row.userId)).size,
    engagementSessions: new Set(exchanges.map((row) => row.engagementSessionId)).size,
    generationCount: generations.length,
    failedGenerations,
    generationFailureRate,
    latestObservedAt: latestObservedAt?.toISOString() ?? null,
  };
  const monitor = await db.releaseMonitor.upsert({
    where: { releaseId_window: { releaseId: release.id, window: input.window } },
    create: {
      releaseId: release.id,
      window: input.window,
      status: mature ? "completed" : "monitoring",
      baseline: {},
      observed: toInputJson(observed),
      verification: toInputJson({
        maturity: mature ? "mature" : "immature",
        recommendation,
        asOf: now.toISOString(),
        windowEnd: windowEnd.toISOString(),
      }),
      startedAt: release.publishedAt,
      finishedAt: mature ? now : null,
    },
    update: {
      status: mature ? "completed" : "monitoring",
      observed: toInputJson(observed),
      verification: toInputJson({
        maturity: mature ? "mature" : "immature",
        recommendation,
        asOf: now.toISOString(),
        windowEnd: windowEnd.toISOString(),
      }),
      finishedAt: mature ? now : null,
    },
  });
  return { monitor, observed, mature, recommendation };
}
