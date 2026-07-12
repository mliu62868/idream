import {
  characterPortfolioDecisionRecordSchema,
  characterPortfolioDecisionRequestSchema,
  characterPortfolioQuerySchema,
  characterPortfolioResponseSchema,
  type CharacterPerformanceSummary,
  type CharacterPerformanceWindow,
  type CharacterPortfolioDecisionRequest,
  type CharacterPortfolioQuery,
} from "@idream/shared/admin";
import type {
  CharacterProject,
  CharacterRelease,
  DecisionRecord,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { effectiveCharacterIdsForPermission } from "@/server/admin/effective-permissions";
import { toInputJson } from "../shared/prisma-json";
import { evaluateCharacterPerformance } from "./performance";

const DAY_MS = 24 * 60 * 60 * 1_000;

function record(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function releasePlacements(release: { releasePlacementManifest: Prisma.JsonValue }) {
  const root = record(release.releasePlacementManifest);
  const raw = Array.isArray(release.releasePlacementManifest)
    ? release.releasePlacementManifest
    : Array.isArray(root.placements)
      ? root.placements
      : [];
  return raw.flatMap((item) => {
    const placement = record(item as Prisma.JsonValue);
    const slotKey = typeof placement.slotKey === "string"
      ? placement.slotKey
      : typeof placement.placementId === "string"
        ? placement.placementId
        : null;
    const assetId = typeof placement.assetId === "string" ? placement.assetId : null;
    if (!slotKey || !assetId) return [];
    return [{
      slotKey,
      slotVersion: typeof placement.slotVersion === "number" && placement.slotVersion > 0
        ? Math.floor(placement.slotVersion)
        : 1,
      assetId,
    }];
  });
}

function projectDto(project: CharacterProject) {
  const audience = record(project.audience);
  const criteria = strings(project.successCriteria);
  return {
    id: project.id,
    characterId: project.characterId,
    ownerId: project.ownerId,
    phase: project.phase,
    audience: stringValue(audience.label ?? audience.segment ?? audience.state, "unavailable"),
    companionNeed: stringValue(audience.companionNeed, "unavailable"),
    hypothesis: project.hypothesis ?? "unavailable",
    differentiation: project.differentiation ?? "unavailable",
    targetPlacementKeys: Array.isArray(audience.targetPlacementKeys)
      ? audience.targetPlacementKeys.filter((item): item is string => typeof item === "string")
      : [],
    successCriteria: criteria.length > 0 ? criteria : ["unavailable:legacy_backfill"],
    plannedLaunchAt: project.plannedLaunchAt?.toISOString() ?? null,
    version: project.version,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function releaseDto(release: CharacterRelease) {
  const provenance = record(release.generationProvenance);
  const placements = releasePlacements(release);
  return {
    id: release.id,
    projectId: release.projectId,
    revisionId: release.revisionId,
    characterContentVersionId: release.characterContentVersionId,
    visualIdentity: {
      visualProfileId: release.visualProfileId ?? "unavailable",
      visualProfileVersion: release.visualProfileVersion && release.visualProfileVersion > 0 ? release.visualProfileVersion : 1,
      anchorAssetId: placements[0]?.assetId ?? "unavailable",
      referenceSetRevisionId: release.referenceSetRevisionId ?? "unavailable",
    },
    generationRoute: {
      generationProfileKey: stringValue(provenance.generationProfileKey, "unavailable"),
      generationProfileVersion: stringValue(provenance.generationProfileVersion, "unavailable"),
      workflowKey: stringValue(provenance.workflowKey, "unavailable"),
      workflowVersion: stringValue(provenance.workflowVersion, "unavailable"),
    },
    releaseOwnedPlacements: placements,
    snapshotHash: release.snapshotHash,
    policyVersion: stringValue(provenance.policyVersion, "character-release-policy-v1"),
    legacy: release.legacy,
    status: release.status,
    publishedAt: release.publishedAt?.toISOString() ?? null,
    supersedesId: release.supersedesId,
    rollbackOfReleaseId: release.rollbackOfReleaseId,
    version: release.version,
    createdAt: release.createdAt.toISOString(),
    updatedAt: release.updatedAt.toISOString(),
  };
}

function decisionDto(row: DecisionRecord) {
  return characterPortfolioDecisionRecordSchema.parse({
    id: row.id,
    characterId: row.sourceId,
    releaseId: row.releaseId ?? "unavailable",
    decision: row.decision,
    question: row.question,
    evidenceRefs: strings(row.evidenceRefs),
    evidenceLevel: row.evidenceLevel,
    confidence: row.confidence,
    ownerId: row.ownerId,
    successCriteria: strings(row.successCriteria),
    guardrails: strings(row.guardrails),
    reviewAt: row.reviewAt?.toISOString() ?? null,
    outcome: row.outcome === null ? null : record(row.outcome),
    createdAt: row.createdAt.toISOString(),
  });
}

async function performanceSummary(
  db: PrismaClient,
  input: {
    readonly characterId: string;
    readonly release: CharacterRelease;
    readonly placementId: string | null;
    readonly window: CharacterPerformanceWindow;
    readonly asOf: Date;
  },
): Promise<CharacterPerformanceSummary> {
  const days = input.window === "7d" ? 7 : 28;
  const windowStart = new Date(input.asOf.getTime() - days * DAY_MS);
  const placementWhere = input.placementId === null ? {} : { placementId: input.placementId };
  const [funnelRows, exposureRows, economicsRows, relevantCosts, projectedCosts] = await Promise.all([
    db.characterFunnelDaily.findMany({
      where: {
        characterId: input.characterId,
        characterContentVersionId: input.release.characterContentVersionId,
        characterReleaseId: input.release.id,
        // Null is the canonical all-placement aggregate. Placement rows are
        // queried individually and must never be summed into it a second time.
        placementId: input.placementId,
        productDay: { gte: windowStart, lt: input.asOf },
      },
    }),
    db.characterExposureFact.findMany({
      where: {
        characterId: input.characterId,
        characterContentVersionId: input.release.characterContentVersionId,
        characterReleaseId: input.release.id,
        ...placementWhere,
        eligible: true,
        occurredAt: { gte: windowStart, lt: input.asOf },
      },
      select: { eventType: true, coverageState: true, occurredAt: true },
    }),
    db.characterEconomicsFact.findMany({
      where: {
        characterId: input.characterId,
        characterContentVersionId: input.release.characterContentVersionId,
        characterReleaseId: input.release.id,
        ...placementWhere,
        occurredAt: { gte: windowStart, lt: input.asOf },
      },
    }),
    db.aiUsageFact.count({
      where: {
        characterId: input.characterId,
        releaseId: input.release.id,
        costMicros: { not: null },
        pricingVersion: { not: null },
        environment: "production",
        dataClass: "customer",
        trustClass: "canonical",
        actorIsInternal: false,
        occurredAt: { gte: windowStart, lt: input.asOf },
      },
    }),
    db.characterEconomicsFact.count({
      where: {
        characterId: input.characterId,
        characterReleaseId: input.release.id,
        kind: "variable_cost",
        authorityType: "ai_usage_fact",
        auditState: "audited",
        coverageState: "exact",
        occurredAt: { gte: windowStart, lt: input.asOf },
      },
    }),
  ]);
  return evaluateCharacterPerformance({
    characterContentVersionId: input.release.characterContentVersionId,
    characterReleaseId: input.release.id,
    placementId: input.placementId,
    releasePublishedAt: input.release.publishedAt ?? input.release.createdAt,
    window: input.window,
    asOf: input.asOf,
    funnelRows,
    exposureRows,
    economicsRows,
    economicsAuthority: {
      // Current CheckoutSession/Subscription rows do not retain captured cash,
      // refunds, credits, or character attribution. Never derive cash from Plan
      // price or Dreamcoin spend.
      cashCaptureComplete: false,
      refundsComplete: false,
      creditsComplete: false,
      variableCostsComplete: input.placementId === null && relevantCosts === projectedCosts,
    },
  });
}

async function changeMarkers(
  db: PrismaClient,
  characterId: string,
  current: CharacterRelease,
  previous: CharacterRelease | null,
  asOf: Date,
) {
  return Promise.all((["7d", "28d"] as const).map(async (window) => {
    const days = window === "7d" ? 7 : 28;
    const currentMatureAt = new Date((current.publishedAt ?? current.createdAt).getTime() + days * DAY_MS);
    const previousMatureAt = previous
      ? new Date((previous.publishedAt ?? previous.createdAt).getTime() + days * DAY_MS)
      : null;
    const currentSummary = await performanceSummary(db, {
      characterId,
      release: current,
      placementId: null,
      window,
      asOf: currentMatureAt <= asOf ? currentMatureAt : asOf,
    });
    const previousSummary = previous && previousMatureAt && previousMatureAt <= asOf
      ? await performanceSummary(db, {
          characterId,
          release: previous,
          placementId: null,
          window,
          asOf: previousMatureAt,
        })
      : null;
    const comparable = currentSummary.qualityState === "certified" && currentSummary.maturity === "mature" &&
      previousSummary?.qualityState === "certified" && previousSummary.maturity === "mature" &&
      currentSummary.qceRate !== null && previousSummary.qceRate !== null &&
      currentSummary.sameCharacterD7 !== null && previousSummary.sameCharacterD7 !== null;
    const currentMargin = currentSummary.contributionMargin;
    const previousMargin = previousSummary?.contributionMargin ?? null;
    return {
      currentReleaseId: current.id,
      previousReleaseId: previous?.id ?? null,
      changedAt: (current.publishedAt ?? current.createdAt).toISOString(),
      window,
      comparable: Boolean(comparable),
      qceRateDelta: comparable ? (currentSummary.qceRate as number) - (previousSummary?.qceRate as number) : null,
      sameCharacterD7Delta: comparable
        ? (currentSummary.sameCharacterD7 as number) - (previousSummary?.sameCharacterD7 as number)
        : null,
      contributionMarginDeltaMicros: comparable && currentMargin.qualityState === "certified" &&
        previousMargin?.qualityState === "certified" && currentMargin.valueMicros !== null && previousMargin.valueMicros !== null
        ? currentMargin.valueMicros - previousMargin.valueMicros
        : null,
      evidence: comparable
        ? [`matched_post_release_${window}_windows`, `current:${current.id}`, `previous:${previous?.id}`]
        : [
            "release_windows_not_comparable",
            ...(previous ? [] : ["previous_release_missing"]),
            ...(currentSummary.maturity !== "mature" ? [`current:${currentSummary.maturity}`] : []),
            ...(previousSummary && previousSummary.maturity !== "mature" ? [`previous:${previousSummary.maturity}`] : []),
          ],
    };
  }));
}

async function filteredCharacterIds(
  db: PrismaClient,
  query: CharacterPortfolioQuery,
  authorizedCharacterIds: readonly string[] | null = null,
) {
  const filters: string[][] = [];
  if (authorizedCharacterIds !== null) filters.push([...authorizedCharacterIds]);
  if (query.search) {
    filters.push((await db.character.findMany({
      where: {
        deletedAt: null,
        OR: [
          { id: { contains: query.search, mode: "insensitive" } },
          { name: { contains: query.search, mode: "insensitive" } },
          { description: { contains: query.search, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    })).map((row) => row.id));
  }
  if (query.servingState) {
    filters.push((await db.characterServing.findMany({
      where: { state: query.servingState },
      select: { characterId: true },
    })).map((row) => row.characterId));
  }
  if (query.readiness) {
    const releases = await db.characterRelease.findMany({
      where: { readiness: query.readiness },
      select: { id: true },
    });
    filters.push((await db.characterServing.findMany({
      where: { currentReleaseId: { in: releases.map((row) => row.id) } },
      select: { characterId: true },
    })).map((row) => row.characterId));
  }
  if (query.decision) {
    const decisions = await db.decisionRecord.findMany({
      where: { sourceType: "character_portfolio" },
      select: { sourceId: true, decision: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const latest = new Map<string, string>();
    for (const decision of decisions) {
      if (!latest.has(decision.sourceId)) latest.set(decision.sourceId, decision.decision);
    }
    filters.push([...latest].filter(([, decision]) => decision === query.decision).map(([characterId]) => characterId));
  }
  if (filters.length === 0) return null;
  return [...filters.slice(1).reduce((current, ids) => {
    const allowed = new Set(ids);
    return new Set([...current].filter((id) => allowed.has(id)));
  }, new Set(filters[0]))];
}

export async function listCharacterPortfolioData(
  db: PrismaClient,
  query: CharacterPortfolioQuery,
  input: { readonly asOf?: Date; readonly assignedActorId?: string; readonly authorizedCharacterIds?: readonly string[] | null } = {},
) {
  const asOf = input.asOf ?? new Date();
  const characterIds = await filteredCharacterIds(db, query, input.authorizedCharacterIds ?? null);
  const projects = await db.characterProject.findMany({
    where: {
      phase: query.phase,
      ownerId: input.assignedActorId ?? query.ownerId,
      id: query.cursor ? { gt: query.cursor } : undefined,
      ...(characterIds ? { characterId: { in: characterIds } } : {}),
    },
    orderBy: { id: "asc" },
    take: query.limit + 1,
  });
  const hasNextPage = projects.length > query.limit;
  const page = projects.slice(0, query.limit);
  const orphanProjectIds: string[] = [];
  const projectedItems = await Promise.all(page.map(async (project) => {
    const [character, serving, latestDecision] = await Promise.all([
      db.character.findUnique({ where: { id: project.characterId } }),
      db.characterServing.findUnique({ where: { characterId: project.characterId } }),
      db.decisionRecord.findFirst({
        where: { sourceType: "character_portfolio", sourceId: project.characterId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    ]);
    if (!character) {
      orphanProjectIds.push(project.id);
      return null;
    }
    const currentRelease = serving?.currentReleaseId
      ? await db.characterRelease.findUnique({ where: { id: serving.currentReleaseId } })
      : null;
    const candidateRelease = await db.characterRelease.findFirst({
      where: {
        projectId: project.id,
        id: currentRelease ? { not: currentRelease.id } : undefined,
        status: { in: ["draft", "validating", "in_review", "approved"] },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    const previousRelease = currentRelease
      ? currentRelease.supersedesId
        ? await db.characterRelease.findUnique({ where: { id: currentRelease.supersedesId } })
        : await db.characterRelease.findFirst({
            where: {
              projectId: project.id,
              id: { not: currentRelease.id },
              status: { in: ["published", "superseded"] },
              publishedAt: currentRelease.publishedAt ? { lt: currentRelease.publishedAt } : undefined,
            },
            orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
          })
      : null;
    const availablePlacements = currentRelease
      ? [...new Set([null, ...releasePlacements(currentRelease).map((placement) => placement.slotKey)])]
      : [];
    const placements = query.placementId
      ? availablePlacements.filter((placementId) => placementId === query.placementId)
      : availablePlacements;
    const performance = currentRelease
      ? await Promise.all(placements.flatMap((placementId) => (["7d", "28d"] as const).map((window) =>
          performanceSummary(db, {
            characterId: project.characterId,
            release: currentRelease,
            placementId,
            window,
            asOf,
          }))))
      : [];
    const validation = currentRelease
      ? await db.releaseValidationRun.findFirst({
          where: { releaseId: currentRelease.id },
          orderBy: { startedAt: "desc" },
        })
      : null;
    const readiness = currentRelease && ["ready", "blocked", "stale", "unknown"].includes(currentRelease.readiness)
      ? currentRelease.readiness as "ready" | "blocked" | "stale" | "unknown"
      : "unknown" as const;
    return {
      characterId: character.id,
      name: character.name,
      project: projectDto(project),
      serving: {
        characterId: character.id,
        state: serving?.state ?? "inactive",
        currentReleaseId: serving?.currentReleaseId ?? null,
        scheduledReleaseId: serving?.scheduledReleaseId ?? null,
        scheduledAt: serving?.scheduledAt?.toISOString() ?? null,
        version: serving?.version ?? 0,
        updatedAt: (serving?.updatedAt ?? project.updatedAt).toISOString(),
      },
      currentRelease: currentRelease ? releaseDto(currentRelease) : null,
      candidateRelease: candidateRelease ? releaseDto(candidateRelease) : null,
      readiness,
      verificationState: validation?.result === "passed" ? "passed" : validation ? "failed" : "pending",
      priority: readiness === "blocked" ? "urgent" : readiness === "stale" ? "high" : "normal",
      performance,
      changeMarkers: currentRelease ? await changeMarkers(db, character.id, currentRelease, previousRelease, asOf) : [],
      latestDecision: latestDecision ? decisionDto(latestDecision) : null,
      operationalState: {
        workflowState: project.phase,
        servingState: serving?.state ?? "inactive",
        qualityState: performance.some((item) => item.qualityState === "invalid") ? "invalid" : "certified",
        readiness,
        checks: [],
        blockers: readiness === "ready" ? [] : [{
          code: `release_${readiness}`,
          message: `Current release readiness is ${readiness}`,
          deepLink: `/admin/characters/${character.id}?tab=overview`,
        }],
        verificationState: validation?.result === "passed" ? "passed" : validation ? "failed" : "pending",
        policyVersion: validation?.policyVersion ?? "character-release-policy-v1",
        entityVersion: currentRelease?.version ?? project.version,
        lastVerifiedAt: validation?.finishedAt?.toISOString() ?? null,
      },
    };
  }));
  const items = projectedItems.filter((item): item is Exclude<typeof item, null> => item !== null);
  const dataQuality: Array<{ code: string; severity: "warning" | "error"; message: string }> = [{
    code: "character_margin_payment_authority_unavailable",
    severity: "warning",
    message: "Contribution margin is invalid until captured cash, refund, credit, and character attribution authorities are available.",
  }];
  if (orphanProjectIds.length > 0) {
    dataQuality.push({
      code: "character_project_orphan",
      severity: "error",
      message: `${orphanProjectIds.length} Character Project row(s) on this page have no Character authority and were excluded; cutover is blocked until reconciliation.`,
    });
  }
  return characterPortfolioResponseSchema.parse({
    items,
    pageInfo: {
      endCursor: hasNextPage ? page.at(-1)?.id ?? null : null,
      hasNextPage,
    },
    asOf: asOf.toISOString(),
    freshness: orphanProjectIds.length > 0 ? "degraded" : "fresh",
    dataQuality,
  });
}

export async function createCharacterPortfolioDecision(
  db: PrismaClient,
  input: {
    readonly characterId: string;
    readonly actor: { readonly id: string; readonly role: string };
    readonly requestId: string;
    readonly body: CharacterPortfolioDecisionRequest;
  },
) {
  const project = await db.characterProject.findFirst({ where: { characterId: input.characterId } });
  if (!project) throw Errors.notFound("Character Project not found");
  if (input.actor.role === "user" && project.ownerId !== input.actor.id) {
    throw Errors.forbidden("Character is outside the producer's assigned scope");
  }
  const release = await db.characterRelease.findUnique({ where: { id: input.body.releaseId } });
  if (!release || release.projectId !== project.id) {
    throw Errors.badRequest("Decision release must belong to the Character Project");
  }
  const created = await db.$transaction(async (tx) => {
    const decision = await tx.decisionRecord.create({
      data: {
        sourceType: "character_portfolio",
        sourceId: input.characterId,
        releaseId: input.body.releaseId,
        question: input.body.question,
        evidenceRefs: toInputJson(input.body.evidenceRefs),
        evidenceLevel: input.body.evidenceLevel,
        decision: input.body.decision,
        confidence: input.body.confidence,
        ownerId: input.actor.id,
        successCriteria: toInputJson(input.body.successCriteria),
        guardrails: toInputJson(input.body.guardrails),
        reviewAt: input.body.reviewAt ? new Date(input.body.reviewAt) : null,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: "character.portfolio.decision.recorded",
        targetType: "character",
        targetId: input.characterId,
        reason: input.body.question,
        after: toInputJson({
          decisionRecordId: decision.id,
          releaseId: input.body.releaseId,
          decision: input.body.decision,
          evidenceLevel: input.body.evidenceLevel,
        }),
        requestId: input.requestId,
      },
    });
    return decision;
  });
  return decisionDto(created);
}

export async function listCharacterPortfolio(request: Request) {
  const actor = await actorWithPermission(request, "character.performance.read");
  const query = characterPortfolioQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const scope = await effectiveCharacterIdsForPermission(actor.id, actor.role, "character.performance.read");
  return ok(await listCharacterPortfolioData(prisma, query, {
    authorizedCharacterIds: scope === null ? null : [...scope],
  }), { headers: { "cache-control": "no-store" } });
}

export async function recordCharacterPortfolioDecision(request: Request, characterId: string) {
  const actor = await actorWithPermission(request, "character.project.write", { characterId });
  const body = characterPortfolioDecisionRequestSchema.parse(await request.json());
  const decision = await createCharacterPortfolioDecision(prisma, {
    characterId,
    actor,
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    body,
  });
  return ok(decision, { status: 201, headers: { "cache-control": "no-store" } });
}
