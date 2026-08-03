import {
  characterPortfolioDecisionRecordSchema,
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
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  isMediaAssetOperationalForAuthority,
} from "@/server/lib/media-asset-authority";
import { actorWithPermission, queryParams } from "@/server/modules/admin-v2/shared/authority";
import {
  effectiveCharacterIdsForPermission,
} from "@/server/admin/effective-permissions";
import {
  operationalCharacterWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import { toInputJson } from "../shared/prisma-json";
import {
  characterReleaseContract,
  characterReleasePlacements,
} from "./character-release-contract";
import {
  draftAssetRouteEntries,
} from "./draft-asset-route-authority";
import {
  completedUtcCharacterPerformanceWindow,
  evaluateCharacterPerformance,
  utcProductDayCeiling,
} from "./performance";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-executor";
import { findOperationalGenerationRoute } from "./visual-authority";
import {
  characterProductionPurposes,
  projectCharacterProductionJourneys,
  projectCurrentDraftAssetPack,
  releaseAssetPack,
  type CharacterProductionAssetPack,
} from "./production-journey";

const DAY_MS = 24 * 60 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> {
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

const characterAssetPurposes = characterProductionPurposes;
type CharacterAssetPack = CharacterProductionAssetPack;

// SPEC: 「需要处理」= 已上线、观察窗口整段走完、却一条观测都没有 —— 铺位定向或事件上报没通，
// 投放在空转。这是列表上没有任何其他地方会说的事。
// INTENT: 只收这一条。资产包不完整已经由每张卡片的 Journey 说了；"无负责人"这类治理欠账
// 对几乎每个角色都为真。多塞一条都会把这个筛子稀释成又一个恒真告警，然后没人再点它。
// 判定必须只依赖 SQL 可精确回答的事实 —— 它跑在主查询之前（要进 where 才能让分页正确），
// 拿不到主查询里那套资产可用性/路线新鲜度的计算。
export const ATTENTION_NO_DATA_WINDOW_DAYS = 7;

export function charactersNeedingAttention(input: {
  readonly live: readonly { readonly characterId: string; readonly currentReleaseId: string | null }[];
  readonly windowClosedReleaseIds: ReadonlySet<string>;
  readonly observedReleaseIds: ReadonlySet<string>;
}) {
  return input.live
    .filter(({ currentReleaseId }) =>
      currentReleaseId !== null &&
      input.windowClosedReleaseIds.has(currentReleaseId) &&
      !input.observedReleaseIds.has(currentReleaseId))
    .map(({ characterId }) => characterId);
}

function assetIds(pack: CharacterAssetPack) {
  return characterAssetPurposes.flatMap((purpose) => {
    const assetId = pack[purpose];
    return assetId ? [assetId] : [];
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
  const reportingWindow = completedUtcCharacterPerformanceWindow({
    asOf: input.asOf,
    window: input.window,
  });
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
        productDay: { gte: reportingWindow.start, lt: reportingWindow.end },
      },
    }),
    db.characterExposureFact.findMany({
      where: {
        characterId: input.characterId,
        characterContentVersionId: input.release.characterContentVersionId,
        characterReleaseId: input.release.id,
        ...placementWhere,
        eligible: true,
        occurredAt: { gte: reportingWindow.start, lt: reportingWindow.end },
      },
      select: {
        exposureId: true,
        parentExposureId: true,
        eventType: true,
        coverageState: true,
        occurredAt: true,
      },
    }),
    db.characterEconomicsFact.findMany({
      where: {
        characterId: input.characterId,
        characterContentVersionId: input.release.characterContentVersionId,
        characterReleaseId: input.release.id,
        ...placementWhere,
        occurredAt: { gte: reportingWindow.start, lt: reportingWindow.end },
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
        occurredAt: { gte: reportingWindow.start, lt: reportingWindow.end },
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
        occurredAt: { gte: reportingWindow.start, lt: reportingWindow.end },
      },
    }),
  ]);
  return evaluateCharacterPerformance({
    characterContentVersionId: input.release.characterContentVersionId,
    characterReleaseId: input.release.id,
    placementId: input.placementId,
    releasePublishedAt: input.release.publishedAt ?? input.release.createdAt,
    window: input.window,
    asOf: reportingWindow.end,
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
    const currentMatureAt = utcProductDayCeiling(
      new Date((current.publishedAt ?? current.createdAt).getTime() + days * DAY_MS),
    );
    const previousMatureAt = previous
      ? utcProductDayCeiling(
          new Date((previous.publishedAt ?? previous.createdAt).getTime() + days * DAY_MS),
        )
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

async function attentionCharacterIds(db: PrismaClient, asOf: Date) {
  const live = await db.characterServing.findMany({
    where: { state: "live" },
    select: { characterId: true, currentReleaseId: true },
  });
  const releaseIds = live
    .map((row) => row.currentReleaseId)
    .filter((id): id is string => id !== null);
  if (releaseIds.length === 0) return [];
  const [windowClosed, exposures, funnels] = await Promise.all([
    db.characterRelease.findMany({
      where: {
        id: { in: releaseIds },
        publishedAt: {
          lte: new Date(asOf.getTime() - ATTENTION_NO_DATA_WINDOW_DAYS * 24 * 60 * 60 * 1_000),
        },
      },
      select: { id: true },
    }),
    db.characterExposureFact.findMany({
      where: { characterReleaseId: { in: releaseIds } },
      select: { characterReleaseId: true },
      distinct: ["characterReleaseId"],
    }),
    db.characterFunnelDaily.findMany({
      where: { characterReleaseId: { in: releaseIds } },
      select: { characterReleaseId: true },
      distinct: ["characterReleaseId"],
    }),
  ]);
  return charactersNeedingAttention({
    live,
    windowClosedReleaseIds: new Set(windowClosed.map((row) => row.id)),
    observedReleaseIds: new Set([...exposures, ...funnels]
      .flatMap((row) => row.characterReleaseId ? [row.characterReleaseId] : [])),
  });
}

async function filteredCharacterIds(
  db: PrismaClient,
  query: CharacterPortfolioQuery,
  authorizedCharacterIds: readonly string[] | null = null,
  asOf: Date = new Date(),
) {
  const filters: string[][] = [];
  if (query.attention) filters.push(await attentionCharacterIds(db, asOf));
  if (authorizedCharacterIds !== null) filters.push([...authorizedCharacterIds]);
  if (query.search) {
    filters.push((await db.character.findMany({
      where: operationalCharacterWhere({
        deletedAt: null,
        OR: [
          { id: { contains: query.search, mode: "insensitive" } },
          { name: { contains: query.search, mode: "insensitive" } },
          { description: { contains: query.search, mode: "insensitive" } },
        ],
      }),
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
  input: {
    readonly asOf?: Date;
    readonly assignedActorId?: string;
    readonly authorizedCharacterIds?: readonly string[] | null;
    readonly authorizedDraftAssetCharacterIds?: readonly string[] | null;
  } = {},
) {
  const asOf = input.asOf ?? new Date();
  const characterIds = await filteredCharacterIds(db, query, input.authorizedCharacterIds ?? null, asOf);
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
  const pageCharacterIds = [...new Set(page.map((project) => project.characterId))];
  const activeVisualAuthorities = pageCharacterIds.length > 0
    ? await db.characterVisualProfile.findMany({
        where: {
          characterId: { in: pageCharacterIds },
          status: "active",
        },
        orderBy: [{ version: "desc" }, { id: "desc" }],
        select: {
          characterId: true,
          style: true,
          referenceSetRevisions: {
            where: { status: "active" },
            orderBy: [{ revision: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              references: {
                orderBy: { position: "asc" },
                select: { role: true },
              },
            },
          },
        },
      })
    : [];
  const activeVisualAuthorityByCharacter = new Map<
    string,
    (typeof activeVisualAuthorities)[number]
  >();
  for (const authority of activeVisualAuthorities) {
    if (!activeVisualAuthorityByCharacter.has(authority.characterId)) {
      activeVisualAuthorityByCharacter.set(authority.characterId, authority);
    }
  }
  const qualifiedRouteByAuthority = new Map<
    string,
    ReturnType<typeof findOperationalGenerationRoute>
  >();
  const qualifiedRouteByCharacter = new Map<
    string,
    Awaited<ReturnType<typeof findOperationalGenerationRoute>>
  >();
  await Promise.all(pageCharacterIds.map(async (characterId) => {
    const authority = activeVisualAuthorityByCharacter.get(characterId);
    if (!authority) {
      qualifiedRouteByCharacter.set(characterId, null);
      return;
    }
    const roles = authority.referenceSetRevisions[0]?.references.map(
      (reference) => reference.role,
    ) ?? [];
    const key = JSON.stringify([authority.style, roles]);
    let route = qualifiedRouteByAuthority.get(key);
    if (!route) {
      route = findOperationalGenerationRoute(db, {
        style: authority.style,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        at: asOf,
        requiredReferenceCount: roles.length,
        requiredReferenceRoles: roles,
      });
      qualifiedRouteByAuthority.set(key, route);
    }
    qualifiedRouteByCharacter.set(characterId, await route);
  }));
  const [
    pageCharacters,
    rawPageCharacters,
    pageServings,
  ] =
    pageCharacterIds.length > 0
      ? await Promise.all([
          db.character.findMany({
            where: operationalCharacterWhere({
              id: { in: pageCharacterIds },
              deletedAt: null,
            }),
          }),
          db.character.findMany({
            where: { id: { in: pageCharacterIds } },
            select: { id: true },
          }),
          db.characterServing.findMany({
            where: { characterId: { in: pageCharacterIds } },
          }),
        ])
      : [[], [], []];
  const pageCharacterById = new Map(
    pageCharacters.map((character) => [character.id, character]),
  );
  const rawPageCharacterIds = new Set(
    rawPageCharacters.map((character) => character.id),
  );
  const pageServingByCharacter = new Map(
    pageServings.map((serving) => [serving.characterId, serving]),
  );
  const currentReleaseIds = [...new Set(pageServings.flatMap((serving) =>
    serving.currentReleaseId ? [serving.currentReleaseId] : []
  ))];
  const pageCurrentReleases = currentReleaseIds.length > 0
    ? await db.characterRelease.findMany({
        where: { id: { in: currentReleaseIds } },
      })
    : [];
  const currentReleaseById = new Map(
    pageCurrentReleases.map((release) => [release.id, release]),
  );
  const pageCandidateAssetIds = [...new Set([
    ...page.flatMap((project) =>
      Object.values(draftAssetRouteEntries(project.draftAssetPack)).map(
        (entry) => entry.assetId,
      )
    ),
    ...pageCurrentReleases.flatMap((release) =>
      characterReleasePlacements(release).map((placement) => placement.assetId)
    ),
  ])];
  const [pageCandidateAssets, candidateAssetCharacterReferences] =
    pageCandidateAssetIds.length > 0
      ? await Promise.all([
          db.mediaAsset.findMany({
            where: operationalMediaAssetWhere({
              id: { in: pageCandidateAssetIds },
              deletedAt: null,
              type: "image",
              safetyStatus: "passed",
            }),
            select: {
              id: true,
              characterId: true,
              url: true,
              thumbnailUrl: true,
              storageKey: true,
              metadata: true,
            },
          }),
          db.character.findMany({
            where: { imageAssetId: { in: pageCandidateAssetIds } },
            select: { id: true, imageAssetId: true },
          }),
        ])
      : [[], []];
  const pageCandidateAssetById = new Map(
    pageCandidateAssets.map((asset) => [asset.id, asset]),
  );
  const characterReferencesByAssetId = new Map<string, string[]>();
  for (const reference of candidateAssetCharacterReferences) {
    if (!reference.imageAssetId) continue;
    const characterIds =
      characterReferencesByAssetId.get(reference.imageAssetId) ?? [];
    characterIds.push(reference.id);
    characterReferencesByAssetId.set(reference.imageAssetId, characterIds);
  }
  const availableAssetIdsByCharacter = new Map<string, ReadonlySet<string>>(
    pageCharacterIds.map((characterId) => [
      characterId,
      new Set(pageCandidateAssets.flatMap((asset) => {
        if (!isMediaAssetOperationalForAuthority(asset.metadata)) return [];
        const belongsToCharacter = asset.characterId === characterId || (
          asset.characterId === null &&
          (characterReferencesByAssetId.get(asset.id) ?? []).length === 1 &&
          characterReferencesByAssetId.get(asset.id)?.[0] === characterId
        );
        return belongsToCharacter ? [asset.id] : [];
      })),
    ]),
  );
  const journeyByCharacter = await projectCharacterProductionJourneys(
    db,
    pageCharacterIds,
    asOf,
    { routeByCharacter: qualifiedRouteByCharacter, availableAssetIdsByCharacter },
  );
  const orphanProjectIds: string[] = [];
  const projectedItems = await Promise.all(page.map(async (project) => {
    const character = pageCharacterById.get(project.characterId) ?? null;
    const serving = pageServingByCharacter.get(project.characterId) ?? null;
    const latestDecision = await db.decisionRecord.findFirst({
      where: { sourceType: "character_portfolio", sourceId: project.characterId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!character) {
      if (!rawPageCharacterIds.has(project.characterId)) {
        orphanProjectIds.push(project.id);
      }
      return null;
    }
    const currentRelease = serving?.currentReleaseId
      ? currentReleaseById.get(serving.currentReleaseId) ?? null
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
      ? [...new Set([null, ...characterReleasePlacements(currentRelease).map((placement) => placement.slotKey)])]
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
    const qualifiedRoute = qualifiedRouteByCharacter.get(project.characterId) ?? null;
    const mayReadDraftAssets =
      input.authorizedDraftAssetCharacterIds === null ||
      input.authorizedDraftAssetCharacterIds?.includes(
        project.characterId,
      ) === true;
    const draftAssetPack = mayReadDraftAssets
      ? projectCurrentDraftAssetPack(
          project,
          qualifiedRoute?.routeFingerprint ?? null,
        )
      : {};
    const liveAssetPack = releaseAssetPack(currentRelease);
    const candidateAssetIds = [...new Set([
      ...assetIds(draftAssetPack),
      ...assetIds(liveAssetPack),
    ])];
    const candidateAssets = candidateAssetIds.flatMap((assetId) => {
      const asset = pageCandidateAssetById.get(assetId);
      return asset ? [asset] : [];
    });
    const availableAssets = new Map(candidateAssets.flatMap((asset) => {
      const imageUrl =
        typeof asset.thumbnailUrl === "string" && asset.thumbnailUrl.trim()
          ? asset.thumbnailUrl
          : typeof asset.url === "string" && asset.url.trim()
            ? asset.url
            : null;
      const exactCharacterReferences =
        characterReferencesByAssetId.get(asset.id) ?? [];
      const ownershipMatches =
        asset.characterId === character.id ||
        (
          asset.characterId === null &&
          exactCharacterReferences.length === 1 &&
          exactCharacterReferences[0] === character.id
        );
      return ownershipMatches &&
        imageUrl !== null &&
        isMediaAssetOperationalForAuthority(asset.metadata)
        ? [[asset.id, { ...asset, imageUrl }] as const]
        : [];
    }));
    const availableAssetIds = new Set(availableAssets.keys());
    const draftPortraitAssetId = draftAssetPack.character_cover ?? null;
    const releasePortraitAssetId = liveAssetPack.character_cover ?? null;
    const primaryImageAssetId =
      draftPortraitAssetId && availableAssetIds.has(draftPortraitAssetId)
        ? draftPortraitAssetId
        : releasePortraitAssetId &&
            availableAssetIds.has(releasePortraitAssetId)
          ? releasePortraitAssetId
          : null;
    const primaryImageSource = primaryImageAssetId === draftPortraitAssetId
      ? "draft" as const
      : primaryImageAssetId
        ? "live" as const
        : null;
    const primaryImageAsset = primaryImageAssetId
      ? availableAssets.get(primaryImageAssetId) ?? null
      : null;
    const journey = journeyByCharacter.get(character.id);
    if (!journey) {
      throw new Error(`Character production journey missing for ${character.id}`);
    }
    const draftPurposes = mayReadDraftAssets
      ? journey.assetPack.draft.availablePurposes
      : [];
    const livePurposes = journey.assetPack.live.availablePurposes;
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
      currentRelease: currentRelease ? characterReleaseContract(currentRelease) : null,
      candidateRelease: candidateRelease ? characterReleaseContract(candidateRelease) : null,
      readiness,
      verificationState: validation?.result === "passed" ? "passed" : validation ? "failed" : "pending",
      priority: readiness === "blocked" ? "urgent" : readiness === "stale" ? "high" : "normal",
      performance,
      changeMarkers: currentRelease ? await changeMarkers(db, character.id, currentRelease, previousRelease, asOf) : [],
      latestDecision: latestDecision ? decisionDto(latestDecision) : null,
      visualProduction: {
        primaryImageUrl: primaryImageAsset?.imageUrl ?? null,
        primaryImageSource:
          primaryImageAsset ? primaryImageSource : null,
        draftPurposes,
        livePurposes,
        totalPurposes: 3,
        deepLink: `/admin/characters/${encodeURIComponent(character.id)}?tab=assets`,
      },
      journey,
      operationalState: {
        workflowState: project.phase,
        servingState: serving?.state ?? "inactive",
        // SPEC: 汇总取最坏，但"全是无观测"要报 no_data，不能借 invalid 冒充数据故障。
        qualityState: performance.some((item) => item.qualityState === "invalid")
          ? "invalid"
          : performance.length > 0 && performance.every((item) => item.qualityState === "no_data")
            ? "no_data"
            : "certified",
        readiness,
        checks: [],
        blockers: readiness === "ready" ? [] : [{
          code: `release_${readiness}`,
          message: `Current release readiness is ${readiness}`,
          deepLink: `/admin/characters/${character.id}?tab=monitor`,
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

export async function createCharacterPortfolioDecisionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    readonly characterId: string;
    readonly actor: { readonly id: string; readonly role: string };
    readonly requestId: string;
    readonly body: CharacterPortfolioDecisionRequest;
  },
) {
  const project = await tx.characterProject.findFirst({ where: { characterId: input.characterId } });
  if (!project) throw Errors.notFound("Character Project not found");
  if (input.actor.role === "user" && project.ownerId !== input.actor.id) {
    throw Errors.forbidden("Character is outside the producer's assigned scope");
  }
  const release = await tx.characterRelease.findUnique({ where: { id: input.body.releaseId } });
  if (!release || release.projectId !== project.id) {
    throw Errors.badRequest("Decision release must belong to the Character Project");
  }
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
  await tx.mainOutboxEvent.create({ data: {
    eventType: "character.portfolio.decision.recorded.v2",
    aggregateType: "character",
    aggregateId: input.characterId,
    payload: toInputJson({ decisionRecordId: decision.id, releaseId: input.body.releaseId, decision: input.body.decision }),
  } });
  return decisionDto(decision);
}

export async function createCharacterPortfolioDecision(
  db: PrismaClient,
  input: Parameters<typeof createCharacterPortfolioDecisionInTransaction>[1],
) {
  return db.$transaction((tx) => createCharacterPortfolioDecisionInTransaction(tx, input));
}

export async function listCharacterPortfolio(request: Request) {
  const actor = await actorWithPermission(request, "character.performance.read");
  const query = queryParams(request, "GET /api/v2/admin/characters/portfolio");
  const [scope, draftAssetScope] = await Promise.all([
    effectiveCharacterIdsForPermission(
      actor.id,
      actor.role,
      "character.performance.read",
    ),
    effectiveCharacterIdsForPermission(
      actor.id,
      actor.role,
      "creative.run.read",
    ),
  ]);
  return ok(await listCharacterPortfolioData(prisma, query, {
    authorizedCharacterIds: scope === null ? null : [...scope],
    authorizedDraftAssetCharacterIds:
      draftAssetScope === null ? null : [...draftAssetScope],
  }), { headers: { "cache-control": "no-store" } });
}
