import { Prisma, type PrismaClient } from "@prisma/client";
import { toInputJson } from "../shared/prisma-json";

export type ReleaseMonitorWindow = "24h" | "72h";

const MONITOR_WINDOWS = ["24h", "72h"] as const satisfies readonly ReleaseMonitorWindow[];
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_RETRY_DELAY_MS = 30 * 1_000;
const MONITOR_AUDIT_ACTION = "character.release.monitor.evaluated";
const MONITOR_OUTBOX_EVENT = "character.release.monitor_evaluated.v2";
const MONITOR_ACTOR_ID = "system:release-monitor-dispatcher";

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
    readonly cursorId?: string;
  },
) {
  const now = input.now ?? new Date();
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const releases = await db.characterRelease.findMany({
    where: {
      status: "published",
      readiness: { not: "stale" },
      AND: [
        ...(input.releaseIds ? [{ id: { in: [...input.releaseIds] } }] : []),
        ...(input.cursorId ? [{ id: { gt: input.cursorId } }] : []),
      ],
    },
    orderBy: { id: "asc" },
    take: limit,
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
  return {
    examined: releases.length,
    stale,
    nextCursor: releases.length === limit ? releases.at(-1)?.id ?? null : null,
  };
}

function windowMs(window: ReleaseMonitorWindow): number {
  return window === "24h" ? 24 * 60 * 60 * 1_000 : 72 * 60 * 60 * 1_000;
}

export function releaseMonitorDueAt(publishedAt: Date, window: ReleaseMonitorWindow): Date {
  return new Date(publishedAt.getTime() + windowMs(window));
}

function releaseAvatarAssetId(manifestValue: Prisma.JsonValue) {
  const manifest = record(manifestValue);
  const placements = Array.isArray(manifest.placements) ? manifest.placements : [];
  for (const value of placements) {
    const placement = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    if (placement.slotKey === "character_avatar" && typeof placement.assetId === "string") return placement.assetId;
  }
  return null;
}

function percentile95(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

export async function collectReleaseMonitorFacts(
  db: Prisma.TransactionClient,
  input: { readonly releaseId: string; readonly window: ReleaseMonitorWindow; readonly now?: Date },
) {
  const now = input.now ?? new Date();
  const release = await db.characterRelease.findUnique({ where: { id: input.releaseId } });
  if (!release?.publishedAt) throw new Error("published Release is required for monitoring");
  const windowEnd = new Date(release.publishedAt.getTime() + windowMs(input.window));
  const observationEnd = now < windowEnd ? now : windowEnd;
  const project = await db.characterProject.findUnique({ where: { id: release.projectId } });
  if (!project) throw new Error("Release Project authority is required for monitoring");
  const avatarAssetId = releaseAvatarAssetId(release.releasePlacementManifest);
  const previousRelease = await db.characterRelease.findFirst({
    where: { projectId: release.projectId, id: { not: release.id }, publishedAt: { lt: release.publishedAt } },
    orderBy: { publishedAt: "desc" },
  });
  const [exchanges, generations, serving, character, contentVersion, avatarAsset, usageFacts, previousMonitor] = await Promise.all([
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
    db.characterServing.findUnique({ where: { characterId: project.characterId } }),
    db.character.findUnique({ where: { id: project.characterId } }),
    db.characterContentVersion.findUnique({ where: { id: release.characterContentVersionId } }),
    avatarAssetId ? db.mediaAsset.findUnique({ where: { id: avatarAssetId } }) : Promise.resolve(null),
    db.aiUsageFact.findMany({
      where: {
        releaseId: release.id,
        environment: "production",
        dataClass: "customer",
        actorIsInternal: false,
        occurredAt: { gte: release.publishedAt, lte: observationEnd },
      },
      select: { latencyMs: true, costMicros: true, occurredAt: true },
    }),
    previousRelease
      ? db.releaseMonitor.findUnique({ where: { releaseId_window: { releaseId: previousRelease.id, window: input.window } } })
      : Promise.resolve(null),
  ]);
  const mature = now.getTime() >= windowEnd.getTime();
  const failedGenerations = generations.filter((row) => row.outcome !== "succeeded").length;
  const generationFailureRate = generations.length > 0 ? failedGenerations / generations.length : null;
  const latencyP95Ms = percentile95(usageFacts.flatMap((fact) => fact.latencyMs === null ? [] : [fact.latencyMs]));
  const variableCostMicros = usageFacts.reduce((sum, fact) => sum + Number(fact.costMicros ?? 0), 0);
  const operationalChecks = {
    releaseReadinessReady: release.readiness === "ready",
    servingPointerLive: serving?.state === "live" && serving.currentReleaseId === release.id,
    publicProjectionLive: character?.status === "approved" && character.visibility === "public" && character.deletedAt === null,
    immutableContentAvailable: contentVersion?.characterId === project.characterId,
    releaseAvatarRenderable: Boolean(avatarAssetId && avatarAsset && !avatarAsset.deletedAt && avatarAsset.safetyStatus === "passed"),
    chatAuthorityReady: serving?.state === "live" && contentVersion?.characterId === project.characterId,
  };
  const operationalPassed = Object.values(operationalChecks).every(Boolean);
  const recommendation = !operationalPassed
    ? "rollback_review"
    : !mature
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
    latencyP95Ms,
    variableCostMicros,
    operationalChecks,
    latestObservedAt: latestObservedAt?.toISOString() ?? null,
  };
  const monitor = await db.releaseMonitor.upsert({
    where: { releaseId_window: { releaseId: release.id, window: input.window } },
    create: {
      releaseId: release.id,
      window: input.window,
      status: !operationalPassed ? "action_required" : mature ? "completed" : "monitoring",
      baseline: toInputJson({
        releaseId: previousRelease?.id ?? null,
        observed: previousMonitor ? record(previousMonitor.observed) : null,
      }),
      observed: toInputJson(observed),
      verification: toInputJson({
        maturity: mature ? "mature" : "immature",
        recommendation,
        asOf: now.toISOString(),
        windowEnd: windowEnd.toISOString(),
        operationalPassed,
        latencySloMs: 5_000,
        latencyWithinSlo: latencyP95Ms === null ? null : latencyP95Ms <= 5_000,
      }),
      startedAt: release.publishedAt,
      finishedAt: mature ? now : null,
    },
    update: {
      status: !operationalPassed ? "action_required" : mature ? "completed" : "monitoring",
      baseline: toInputJson({
        releaseId: previousRelease?.id ?? null,
        observed: previousMonitor ? record(previousMonitor.observed) : null,
      }),
      observed: toInputJson(observed),
      verification: toInputJson({
        maturity: mature ? "mature" : "immature",
        recommendation,
        asOf: now.toISOString(),
        windowEnd: windowEnd.toISOString(),
        operationalPassed,
        latencySloMs: 5_000,
        latencyWithinSlo: latencyP95Ms === null ? null : latencyP95Ms <= 5_000,
      }),
      finishedAt: mature ? now : null,
    },
  });
  return { monitor, observed, mature, recommendation };
}

type DispatchFailure = {
  readonly monitorId: string;
  readonly message: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function monitorOccurrenceKey(monitor: { id: string; releaseId: string; window: string }): string {
  return `release-monitor:${monitor.releaseId}:${monitor.window}:${monitor.id}`;
}

async function appendMonitorEvaluationEvidence(
  tx: Prisma.TransactionClient,
  input: {
    readonly monitor: { id: string; releaseId: string; window: string };
    readonly status: string;
    readonly recommendation: string;
    readonly characterId: string | null;
    readonly observedAt: Date;
  },
) {
  const occurrenceKey = monitorOccurrenceKey(input.monitor);
  const evidence = {
    occurrenceKey,
    monitorId: input.monitor.id,
    releaseId: input.monitor.releaseId,
    characterId: input.characterId,
    window: input.monitor.window,
    status: input.status,
    recommendation: input.recommendation,
    observedAt: input.observedAt.toISOString(),
  };
  await tx.adminAuditLog.create({
    data: {
      id: `audit:${occurrenceKey}`,
      actorId: MONITOR_ACTOR_ID,
      actorRole: "system",
      action: MONITOR_AUDIT_ACTION,
      targetType: "release_monitor",
      targetId: input.monitor.id,
      reason: `Evaluate due ${input.monitor.window} Release Monitor`,
      after: toInputJson(evidence),
      requestId: occurrenceKey,
      createdAt: input.observedAt,
    },
  });
  await tx.mainOutboxEvent.create({
    data: {
      id: `outbox:${occurrenceKey}`,
      eventType: MONITOR_OUTBOX_EVENT,
      aggregateType: "character_release",
      aggregateId: input.monitor.releaseId,
      payload: toInputJson(evidence),
      nextRunAt: input.observedAt,
      createdAt: input.observedAt,
    },
  });
}

export async function dispatchDueReleaseMonitors(
  db: PrismaClient,
  input: {
    readonly workerId: string;
    readonly now?: Date;
    readonly limit?: number;
    readonly leaseMs?: number;
    readonly retryDelayMs?: number;
  },
) {
  const now = input.now ?? new Date();
  const leaseMs = Math.max(1_000, input.leaseMs ?? DEFAULT_LEASE_MS);
  const retryDelayMs = Math.max(1_000, input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const candidates = await db.releaseMonitor.findMany({
    where: {
      window: { in: [...MONITOR_WINDOWS] },
      status: { in: ["pending", "monitoring"] },
      dueAt: { lte: now },
      AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: Math.min(500, Math.max(1, input.limit ?? 100)),
    select: { id: true },
  });
  let claimed = 0;
  let evaluated = 0;
  let completed = 0;
  let actionRequired = 0;
  let superseded = 0;
  const failures: DispatchFailure[] = [];

  for (const candidate of candidates) {
    const claim = await db.releaseMonitor.updateMany({
      where: {
        id: candidate.id,
        window: { in: [...MONITOR_WINDOWS] },
        status: { in: ["pending", "monitoring"] },
        dueAt: { lte: now },
        AND: [
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        ],
      },
      data: {
        leaseOwner: input.workerId,
        leaseExpiresAt,
        attemptCount: { increment: 1 },
      },
    });
    if (claim.count !== 1) continue;
    claimed += 1;

    try {
      const outcome = await db.$transaction(async (tx) => {
        const locked = await tx.releaseMonitor.updateMany({
          where: {
            id: candidate.id,
            leaseOwner: input.workerId,
            status: { in: ["pending", "monitoring"] },
          },
          data: { leaseExpiresAt: new Date(now.getTime() + leaseMs) },
        });
        if (locked.count !== 1) return null;
        const monitor = await tx.releaseMonitor.findUniqueOrThrow({ where: { id: candidate.id } });
        if (monitor.window !== "24h" && monitor.window !== "72h") return null;
        const release = await tx.characterRelease.findUnique({ where: { id: monitor.releaseId } });
        const project = release
          ? await tx.characterProject.findUnique({ where: { id: release.projectId } })
          : null;
        const serving = project
          ? await tx.characterServing.findUnique({ where: { characterId: project.characterId } })
          : null;
        const isCurrentRelease = release?.status === "published" && serving?.currentReleaseId === release.id;

        if (!release?.publishedAt || !project || !isCurrentRelease) {
          const verification = {
            state: "superseded",
            recommendation: "no_longer_serving",
            asOf: now.toISOString(),
            releaseStatus: release?.status ?? "missing",
            currentReleaseId: serving?.currentReleaseId ?? null,
          };
          await tx.releaseMonitor.update({
            where: { id: monitor.id },
            data: {
              status: "superseded",
              verification: toInputJson(verification),
              finishedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              lastError: Prisma.DbNull,
            },
          });
          await appendMonitorEvaluationEvidence(tx, {
            monitor,
            status: "superseded",
            recommendation: "no_longer_serving",
            characterId: project?.characterId ?? null,
            observedAt: now,
          });
          return "superseded" as const;
        }

        const result = await collectReleaseMonitorFacts(tx, {
          releaseId: release.id,
          window: monitor.window,
          now,
        });
        await tx.releaseMonitor.update({
          where: { id: monitor.id },
          data: {
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            lastError: Prisma.DbNull,
          },
        });
        await appendMonitorEvaluationEvidence(tx, {
          monitor,
          status: result.monitor.status,
          recommendation: result.recommendation,
          characterId: project.characterId,
          observedAt: now,
        });
        return result.monitor.status === "action_required" ? "action_required" as const : "completed" as const;
      });
      if (!outcome) continue;
      evaluated += 1;
      if (outcome === "action_required") actionRequired += 1;
      else if (outcome === "superseded") superseded += 1;
      else completed += 1;
    } catch (error) {
      const message = errorMessage(error);
      failures.push({ monitorId: candidate.id, message });
      await db.releaseMonitor.updateMany({
        where: { id: candidate.id, leaseOwner: input.workerId, status: { in: ["pending", "monitoring"] } },
        data: {
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs),
          lastError: toInputJson({ message, failedAt: now.toISOString() }),
        },
      });
    }
  }

  return {
    examined: candidates.length,
    claimed,
    evaluated,
    completed,
    actionRequired,
    superseded,
    failed: failures.length,
    failures,
  };
}
