import { Prisma, type PrismaClient } from "@prisma/client";
import {
  characterReleaseAssetPlacement,
  parseCharacterReleaseAssetManifest,
  type CharacterReleaseAssetSlot,
} from "@idream/shared/admin";
import {
  evaluateMediaAssetCustomerPublishability,
  isMockGenerationProvider,
  type MediaAssetCustomerPublishabilityReason,
} from "@/server/lib/media-asset-authority";
import { toInputJson } from "../shared/prisma-json";
import {
  evaluateEffectiveGenerationRouteAuthority,
} from "./generation-route-authority";

export { evaluateRouteQualification } from "./generation-route-authority";

export type ReleaseMonitorWindow = "24h" | "72h";

export const CHARACTER_RELEASE_MONITOR_POLICY_VERSION =
  "character-release-monitor-policy-v1";

const MONITOR_WINDOWS = ["24h", "72h"] as const satisfies readonly ReleaseMonitorWindow[];
const RELEASE_ASSET_SLOTS = [
  "character_avatar",
  "character_hero",
  "character_chat",
] as const satisfies readonly CharacterReleaseAssetSlot[];
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_RETRY_DELAY_MS = 30 * 1_000;
const MONITOR_AUDIT_ACTION = "character.release.monitor.evaluated";
const MONITOR_OUTBOX_EVENT = "character.release.monitor_evaluated.v2";
const MONITOR_ACTOR_ID = "system:release-monitor-dispatcher";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function immutableGenerationProviders(value: Prisma.JsonValue) {
  const provenance = record(value);
  const placements = Array.isArray(provenance.placements)
    ? provenance.placements
    : [];
  const placementEntries = new Map<
    CharacterReleaseAssetSlot,
    Array<{ assetId: string | null; provider: string | null }>
  >();
  for (const slot of RELEASE_ASSET_SLOTS) placementEntries.set(slot, []);
  for (const value of placements) {
    const placement = record(value);
    const slotKey = stringValue(placement.slotKey);
    const assetId = stringValue(placement.assetId);
    const provider = stringValue(placement.provider);
    if (
      !slotKey ||
      !RELEASE_ASSET_SLOTS.some((slot) => slot === slotKey)
    ) {
      continue;
    }
    placementEntries.get(slotKey as CharacterReleaseAssetSlot)?.push({
      assetId,
      provider,
    });
  }
  return {
    placementEntries,
    legacyProvider: stringValue(provenance.provider),
  };
}

function immutableProviderAuthority(
  providers: ReturnType<typeof immutableGenerationProviders>,
  input: {
    readonly slot: CharacterReleaseAssetSlot;
    readonly assetId: string;
    readonly strict: boolean;
  },
) {
  if (!input.strict) {
    return {
      provider: providers.legacyProvider,
      missing: false,
      duplicate: false,
      assetMismatch: false,
    };
  }
  const entries = providers.placementEntries.get(input.slot) ?? [];
  const entry = entries.length === 1 ? entries[0] ?? null : null;
  return {
    provider: entry?.provider ?? null,
    missing: entries.length === 0 || !entry?.provider,
    duplicate: entries.length > 1,
    assetMismatch: Boolean(entry && entry.assetId !== input.assetId),
  };
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
      // Generation-route qualification is an authority of modern generated
      // Releases only. Legacy/editorial Releases have a separate catalog
      // authority and must never be reclassified as a missing generation
      // route, even when that independent authority needs repair.
      legacy: false,
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
    const provenance = record(release.generationProvenance);
    const requiredRoute = record(provenance.requiredReleaseRoute);
    const routeFingerprint = typeof requiredRoute.routeFingerprint === "string"
      ? requiredRoute.routeFingerprint
      : provenance.routeFingerprint;
    const qualification = typeof routeFingerprint === "string"
      ? await db.generationRouteQualification.findFirst({
          where: { routeFingerprint },
          orderBy: { evaluatedAt: "desc" },
        })
      : null;
    const requiredReferences = release.referenceSetRevisionId
      ? await db.characterVisualReferenceSnapshot.findMany({
          where: { referenceSetRevisionId: release.referenceSetRevisionId },
          select: { role: true },
          orderBy: { position: "asc" },
        })
      : [];
    const effective = await evaluateEffectiveGenerationRouteAuthority(db, {
      qualification,
      currentPolicyVersion: input.currentPolicyVersion,
      currentEvaluatorVersion: input.currentEvaluatorVersion,
      now,
      requiredReferenceCount: requiredReferences.length,
      requiredReferenceRoles:
        requiredReferences.map((reference) => reference.role),
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
      const serving = await tx.characterServing.findUnique({
        where: { characterId: project.characterId },
        select: { state: true, currentReleaseId: true },
      });
      const catalogProjectionChanged =
        serving?.state === "live" &&
        serving.currentReleaseId === release.id
          ? (
              await tx.character.updateMany({
                where: {
                  id: project.characterId,
                  visibility: "public",
                  status: "approved",
                  deletedAt: null,
                },
                data: { visibility: "unlisted" },
              })
            ).count === 1
          : false;
      await tx.characterReleaseEvent.create({
        data: {
          releaseId: release.id,
          characterId: project.characterId,
          type: "generation_route_qualification_stale",
          reason: effective.reason,
          fromState: toInputJson({ readiness: release.readiness, routeFingerprint }),
          toState: toInputJson({
            readiness: "stale",
            effectiveQualification: effective.state,
            catalogVisibility:
              catalogProjectionChanged ? "unlisted" : "unchanged",
          }),
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
          verification: toInputJson({
            servingChanged: false,
            catalogProjectionChanged,
            checkedAt: now.toISOString(),
          }),
          startedAt: now,
        },
        update: {
          status: "action_required",
          observed: toInputJson({ effectiveQualification: effective.state, reason: effective.reason }),
          verification: toInputJson({
            servingChanged: false,
            catalogProjectionChanged,
            checkedAt: now.toISOString(),
          }),
        },
      });
      await tx.mainOutboxEvent.create({
        data: {
          eventType: "character.release.qualification_stale.v2",
          aggregateType: "character_release",
          aggregateId: release.id,
          status: "delivered",
          deliveredAt: now,
          payload: toInputJson({
            releaseId: release.id,
            characterId: project.characterId,
            effectiveQualification: effective.state,
            reason: effective.reason,
            catalogProjectionChanged,
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
  const projectCharacterId = project.characterId;
  const rawManifest = record(release.releasePlacementManifest);
  const strictManifestDeclared = rawManifest.schemaVersion === 2;
  const strictManifest = parseCharacterReleaseAssetManifest(
    release.releasePlacementManifest,
  );
  const manifestMode = strictManifest
    ? "v2"
    : strictManifestDeclared
      ? "invalid_v2"
      : "legacy";
  const generationProviders = immutableGenerationProviders(
    release.generationProvenance,
  );
  const legacyAvatarAssetId = releaseAvatarAssetId(
    release.releasePlacementManifest,
  );
  const placementBySlot = new Map<
    CharacterReleaseAssetSlot,
    { assetId: string }
  >();
  if (strictManifest) {
    for (const slot of RELEASE_ASSET_SLOTS) {
      const placement = characterReleaseAssetPlacement(strictManifest, slot);
      if (placement) placementBySlot.set(slot, placement);
    }
  } else if (!strictManifestDeclared && legacyAvatarAssetId) {
    placementBySlot.set("character_avatar", {
      assetId: legacyAvatarAssetId,
    });
  }
  const placementAssetIds = [
    ...new Set([...placementBySlot.values()].map((placement) => placement.assetId)),
  ];
  const previousRelease = await db.characterRelease.findFirst({
    where: { projectId: release.projectId, id: { not: release.id }, publishedAt: { lt: release.publishedAt } },
    orderBy: { publishedAt: "desc" },
  });
  const [exchanges, generations, serving, character, contentVersion, placementAssets, usageFacts, previousMonitor] = await Promise.all([
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
    db.characterServing.findUnique({ where: { characterId: projectCharacterId } }),
    db.character.findUnique({ where: { id: projectCharacterId } }),
    db.characterContentVersion.findUnique({ where: { id: release.characterContentVersionId } }),
    placementAssetIds.length > 0
      ? db.mediaAsset.findMany({ where: { id: { in: placementAssetIds } } })
      : Promise.resolve([]),
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
  const placementAssetById = new Map(
    placementAssets.map((asset) => [asset.id, asset]),
  );
  type ReleaseAssetSlotEvidence = {
    assetId: string | null;
    exists: boolean;
    characterMatch: boolean;
    renderable: boolean;
    customerReadable: boolean;
    provider: string | null;
    providerMissing: boolean;
    providerDuplicate: boolean;
    providerAssetMismatch: boolean;
    metadataSynthetic: boolean;
    metadataSyntheticMarkerInvalid: boolean;
    mockProvider: boolean;
    synthetic: boolean;
    syntheticReasons: readonly MediaAssetCustomerPublishabilityReason[];
  };
  function releaseAssetSlotEvidence(
    slot: CharacterReleaseAssetSlot,
  ): ReleaseAssetSlotEvidence {
    const placement = placementBySlot.get(slot);
    const asset = placement
      ? placementAssetById.get(placement.assetId) ?? null
      : null;
    const providerAuthority = placement
      ? immutableProviderAuthority(generationProviders, {
          slot,
          assetId: placement.assetId,
          strict: manifestMode === "v2",
        })
      : {
          provider: null,
          missing: manifestMode === "v2",
          duplicate: false,
          assetMismatch: false,
        };
    const provider = providerAuthority.provider;
    const renderable = Boolean(
      placement &&
      asset &&
      asset.characterId === projectCharacterId &&
      asset.type === "image" &&
      asset.deletedAt === null &&
      asset.safetyStatus === "passed" &&
      (asset.storageKey || asset.url),
    );
    const publishability = evaluateMediaAssetCustomerPublishability({
      metadata: asset?.metadata,
      pinnedProvider: provider,
      pinnedProviderRequired: manifestMode === "v2",
      pinnedProviderDuplicate: providerAuthority.duplicate,
      pinnedProviderAssetMismatch: providerAuthority.assetMismatch,
    });
    const mockProvider = isMockGenerationProvider(provider);
    const syntheticReasons = publishability.reasons;
    const synthetic = syntheticReasons.length > 0;
    const customerReadable = Boolean(
      renderable &&
      asset?.visibility === "public_pack" &&
      !synthetic,
    );
    return {
      assetId: placement?.assetId ?? null,
      exists: Boolean(asset),
      characterMatch: asset?.characterId === projectCharacterId,
      renderable,
      customerReadable,
      provider,
      providerMissing: providerAuthority.missing,
      providerDuplicate: providerAuthority.duplicate,
      providerAssetMismatch: providerAuthority.assetMismatch,
      metadataSynthetic: syntheticReasons.includes("metadata_synthetic"),
      metadataSyntheticMarkerInvalid: syntheticReasons.includes(
        "metadata_synthetic_marker_invalid",
      ),
      mockProvider,
      synthetic,
      syntheticReasons,
    };
  }
  const releaseAssetSlots = {
    character_avatar: releaseAssetSlotEvidence("character_avatar"),
    character_hero: releaseAssetSlotEvidence("character_hero"),
    character_chat: releaseAssetSlotEvidence("character_chat"),
  } satisfies Record<CharacterReleaseAssetSlot, ReleaseAssetSlotEvidence>;
  const avatarSlot = releaseAssetSlots.character_avatar;
  const heroSlot = releaseAssetSlots.character_hero;
  const chatSlot = releaseAssetSlots.character_chat;
  const operationalChecks = {
    releaseReadinessReady: release.readiness === "ready",
    releaseAssetManifestComplete: strictManifest
      ? placementBySlot.size === 3
      : !strictManifestDeclared && Boolean(legacyAvatarAssetId),
    servingPointerLive: serving?.state === "live" && serving.currentReleaseId === release.id,
    publicProjectionLive:
      character?.status === "approved" &&
      character.visibility === "public" &&
      character.deletedAt === null &&
      character.imageAssetId === avatarSlot.assetId,
    immutableContentAvailable: contentVersion?.characterId === projectCharacterId,
    releaseAvatarRenderable: avatarSlot.renderable,
    releaseAvatarVisible: avatarSlot.customerReadable,
    ...(strictManifest
      ? {
          releaseHeroRenderable: heroSlot.renderable,
          releaseHeroVisible: heroSlot.customerReadable,
          releaseChatRenderable: chatSlot.renderable,
          releaseChatVisible: chatSlot.customerReadable,
        }
      : {}),
    chatAuthorityReady:
      serving?.state === "live" &&
      contentVersion?.characterId === projectCharacterId &&
      (!strictManifest ||
        (chatSlot.renderable && chatSlot.customerReadable)),
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
    policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
    exchangeCount: exchanges.length,
    uniqueUsers: new Set(exchanges.map((row) => row.userId)).size,
    engagementSessions: new Set(exchanges.map((row) => row.engagementSessionId)).size,
    generationCount: generations.length,
    failedGenerations,
    generationFailureRate,
    latencyP95Ms,
    variableCostMicros,
    releaseAssetManifestMode: manifestMode,
    releaseAssetSlots,
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
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
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
        policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
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
  return {
    monitor,
    observed,
    mature,
    recommendation,
    policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
  };
}

type DispatchFailure = {
  readonly monitorId: string;
  readonly message: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function monitorOccurrenceKey(
  monitor: { id: string; releaseId: string; window: string },
  policyVersion: string,
): string {
  return `release-monitor:${monitor.releaseId}:${monitor.window}:${monitor.id}:${policyVersion}`;
}

async function appendMonitorEvaluationEvidence(
  tx: Prisma.TransactionClient,
  input: {
    readonly monitor: { id: string; releaseId: string; window: string };
    readonly status: string;
    readonly recommendation: string;
    readonly characterId: string | null;
    readonly observedAt: Date;
    readonly policyVersion: string;
  },
) {
  const occurrenceKey = monitorOccurrenceKey(
    input.monitor,
    input.policyVersion,
  );
  const evidence = {
    occurrenceKey,
    policyVersion: input.policyVersion,
    monitorId: input.monitor.id,
    releaseId: input.monitor.releaseId,
    characterId: input.characterId,
    window: input.monitor.window,
    status: input.status,
    recommendation: input.recommendation,
    observedAt: input.observedAt.toISOString(),
  };
  await tx.adminAuditLog.createMany({
    data: [{
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
    }],
    skipDuplicates: true,
  });
  await tx.mainOutboxEvent.createMany({
    data: [{
      id: `outbox:${occurrenceKey}`,
      eventType: MONITOR_OUTBOX_EVENT,
      aggregateType: "character_release",
      aggregateId: input.monitor.releaseId,
      payload: toInputJson(evidence),
      nextRunAt: input.observedAt,
      createdAt: input.observedAt,
    }],
    skipDuplicates: true,
  });
}

async function requeueOutdatedCompletedReleaseMonitors(
  db: PrismaClient,
  input: {
    readonly now: Date;
    readonly limit: number;
  },
) {
  const requeued = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH candidates AS (
      SELECT monitor."id"
      FROM "release_monitors" AS monitor
      INNER JOIN "character_releases" AS release
        ON release."id" = monitor."releaseId"
      INNER JOIN "character_projects" AS project
        ON project."id" = release."projectId"
      INNER JOIN "character_serving" AS serving
        ON serving."characterId" = project."characterId"
      WHERE monitor."status" = 'completed'
        AND monitor."window" IN ('24h', '72h')
        AND COALESCE(
          monitor."verification" ->> 'policyVersion',
          ''
        ) <> ${CHARACTER_RELEASE_MONITOR_POLICY_VERSION}
        AND release."status" = 'published'
        AND release."publishedAt" IS NOT NULL
        AND serving."state" = 'live'
        AND serving."currentReleaseId" = release."id"
        AND (
          monitor."leaseOwner" IS NULL
          OR monitor."leaseExpiresAt" IS NULL
          OR monitor."leaseExpiresAt" <= ${input.now}
        )
      ORDER BY
        COALESCE(monitor."dueAt", monitor."startedAt") ASC,
        monitor."id" ASC
      FOR UPDATE OF monitor SKIP LOCKED
      LIMIT ${input.limit}
    )
    UPDATE "release_monitors" AS monitor
    SET
      "status" = 'pending',
      "finishedAt" = NULL,
      "dueAt" = ${input.now},
      "leaseOwner" = NULL,
      "leaseExpiresAt" = NULL,
      "nextAttemptAt" = NULL,
      "lastError" = NULL,
      "verification" = monitor."verification" || jsonb_build_object(
        'state',
        'pending_policy_recheck',
        'previousPolicyVersion',
        monitor."verification" ->> 'policyVersion',
        'requestedPolicyVersion',
        CAST(${CHARACTER_RELEASE_MONITOR_POLICY_VERSION} AS text),
        'requeuedAt',
        CAST(${input.now.toISOString()} AS text)
      )
    FROM candidates
    WHERE monitor."id" = candidates."id"
      AND monitor."status" = 'completed'
    RETURNING monitor."id"
  `);
  return requeued.length;
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
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const requeued = await requeueOutdatedCompletedReleaseMonitors(db, {
    now,
    limit,
  });
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
    take: limit,
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
            policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
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
            policyVersion: CHARACTER_RELEASE_MONITOR_POLICY_VERSION,
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
          policyVersion: result.policyVersion,
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
    requeued,
    claimed,
    evaluated,
    completed,
    actionRequired,
    superseded,
    failed: failures.length,
    failures,
  };
}
