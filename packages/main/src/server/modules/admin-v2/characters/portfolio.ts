import {
  characterPortfolioResponseSchema,
  type CharacterPortfolioFacets,
  type CharacterPerformanceSummary,
  type CharacterPerformanceWindow,
  type CharacterPortfolioQuery,
} from "@idream/shared/admin";
import {
  Prisma,
  type CharacterProject,
  type CharacterRelease,
  type PrismaClient,
} from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { ok } from "@/server/lib/http";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import {
  actorWithPermission,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import {
  type AdminKeysetKey,
  type AdminKeysetPaging,
  paginateAdminKeyset,
} from "@/server/modules/admin-v2/shared/list-cursor";
import { effectiveCharacterIdsForPermission } from "@/server/admin/effective-permissions";
import { readCharacterVariableCostCoverage } from "./performance-facts";
import {
  OPERATIONAL_USER_DATA_CLASS_SQL,
  operationalCharacterWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import {
  characterReleaseContract,
  characterReleasePlacements,
} from "./character-release-contract";
import { draftAssetRouteEntries } from "./draft-asset-route-authority";
import {
  completedUtcCharacterPerformanceWindow,
  evaluateCharacterPerformance,
  utcProductDayCeiling,
} from "./performance";
import { CHARACTER_RELEASE_POLICY_VERSION } from "./release-validation";
import { findOperationalGenerationRoute } from "./visual-authority";
import { characterWorkspaceTabLink } from "./character-deep-link";
import {
  characterAttentionReason,
  type CharacterAttentionReason,
} from "./character-attention";
import {
  characterPeerBaselines,
  characterPerformanceRecommendation,
  characterPlatformDecliners,
  peerKey,
  type CharacterPeerFunnelRow,
} from "./performance-recommendation";
import { workQueueCharacterIds } from "./portfolio-work-queue";
import {
  releaseMonitorActionSql,
  releaseNoTrafficSql,
} from "../today/work-severity";
import {
  availablePurposes,
  characterProductionPurposes,
  projectCharacterProductionJourneys,
  projectCurrentDraftAssetPack,
  releaseAssetPack,
  type CharacterProductionAssetPack,
} from "./production-journey";

const DAY_MS = 24 * 60 * 60 * 1_000;

const characterAssetPurposes = characterProductionPurposes;
type CharacterAssetPack = CharacterProductionAssetPack;

function assetIds(pack: CharacterAssetPack) {
  return characterAssetPurposes.flatMap((purpose) => {
    const assetId = pack[purpose];
    return assetId ? [assetId] : [];
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
  const placementWhere =
    input.placementId === null ? {} : { placementId: input.placementId };
  const [
    funnelRows,
    exposureRows,
    economicsRows,
    costCoverage,
  ] = await Promise.all([
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
    readCharacterVariableCostCoverage(db, {
      characterId: input.characterId,
      releaseId: input.release.id,
      windowStart: reportingWindow.start,
      windowEnd: reportingWindow.end,
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
      variableCostsComplete:
        input.placementId === null && costCoverage.complete,
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
  return Promise.all(
    (["7d", "28d"] as const).map(async (window) => {
      const days = window === "7d" ? 7 : 28;
      const currentMatureAt = utcProductDayCeiling(
        new Date(
          (current.publishedAt ?? current.createdAt).getTime() + days * DAY_MS,
        ),
      );
      const previousMatureAt = previous
        ? utcProductDayCeiling(
            new Date(
              (previous.publishedAt ?? previous.createdAt).getTime() +
                days * DAY_MS,
            ),
          )
        : null;
      const currentSummary = await performanceSummary(db, {
        characterId,
        release: current,
        placementId: null,
        window,
        asOf: currentMatureAt <= asOf ? currentMatureAt : asOf,
      });
      const previousSummary =
        previous && previousMatureAt && previousMatureAt <= asOf
          ? await performanceSummary(db, {
              characterId,
              release: previous,
              placementId: null,
              window,
              asOf: previousMatureAt,
            })
          : null;
      // SPEC: 漏斗投影写不出 exact（付费归因不可用），质量最多 directional。对比接受它并如实
      //       标注；只要求两侧窗口成熟、口径可用。QCE 与 D7 各自有分母才各自出差值。
      const usable = (quality: string | undefined) =>
        quality === "certified" || quality === "directional";
      const qceComparable =
        currentSummary.qceRate !== null && previousSummary?.qceRate !== null && previousSummary?.qceRate !== undefined;
      const d7Comparable =
        currentSummary.sameCharacterD7 !== null &&
        previousSummary?.sameCharacterD7 !== null && previousSummary?.sameCharacterD7 !== undefined;
      const comparable =
        usable(currentSummary.qualityState) &&
        currentSummary.maturity === "mature" &&
        usable(previousSummary?.qualityState) &&
        previousSummary?.maturity === "mature" &&
        (qceComparable || d7Comparable);
      const currentMargin = currentSummary.contributionMargin;
      const previousMargin = previousSummary?.contributionMargin ?? null;
      return {
        currentReleaseId: current.id,
        previousReleaseId: previous?.id ?? null,
        changedAt: (current.publishedAt ?? current.createdAt).toISOString(),
        window,
        comparable: Boolean(comparable),
        comparisonQuality: comparable
          ? currentSummary.qualityState === "certified" && previousSummary?.qualityState === "certified"
            ? ("certified" as const)
            : ("directional" as const)
          : null,
        qceRateDelta: comparable && qceComparable
          ? (currentSummary.qceRate as number) -
            (previousSummary?.qceRate as number)
          : null,
        sameCharacterD7Delta: comparable && d7Comparable
          ? (currentSummary.sameCharacterD7 as number) -
            (previousSummary?.sameCharacterD7 as number)
          : null,
        contributionMarginDeltaMicros:
          comparable &&
          currentMargin.qualityState === "certified" &&
          previousMargin?.qualityState === "certified" &&
          currentMargin.valueMicros !== null &&
          previousMargin.valueMicros !== null
            ? currentMargin.valueMicros - previousMargin.valueMicros
            : null,
        evidence: comparable
          ? [
              `matched_post_release_${window}_windows`,
              `current:${current.id}`,
              `previous:${previous?.id}`,
            ]
          : [
              "release_windows_not_comparable",
              ...(previous ? [] : ["previous_release_missing"]),
              ...(currentSummary.maturity !== "mature"
                ? [`current:${currentSummary.maturity}`]
                : []),
              ...(previousSummary && previousSummary.maturity !== "mature"
                ? [`previous:${previousSummary.maturity}`]
                : []),
            ],
      };
    }),
  );
}

// SPEC: 「需要处理」只收会让线上运营静默出问题的事实，原因函数与 Today 共用。
// INTENT: 判定只依赖分页前可精确查询的权威事实，才能形成真正的跨页工作队列；
//         不把普通的制作中状态塞进来，避免筛选退化成恒真告警。
async function attentionByCharacter(
  db: PrismaClient,
  asOf: Date,
  characterIds?: readonly string[],
) {
  if (characterIds?.length === 0) return new Map<string, CharacterAttentionReason>();
  const release = Prisma.sql`release`;
  const rows = await db.$queryRaw<Array<{
    characterId: string;
    monitorActionRequired: boolean;
    noTraffic: boolean;
  }>>(Prisma.sql`
    SELECT * FROM (
      SELECT serving."characterId",
        ${releaseMonitorActionSql(release)} AS "monitorActionRequired",
        ${releaseNoTrafficSql(release, asOf)} AS "noTraffic"
      FROM "character_serving" serving
      JOIN "character_releases" release ON release.id = serving."currentReleaseId"
      ${characterIds ? Prisma.sql`WHERE serving."characterId" = ANY(${[...characterIds]}::text[])` : Prisma.empty}
    ) AS facts
    WHERE "monitorActionRequired" OR "noTraffic"
  `);
  return new Map(
    rows.flatMap((row) => {
      const reason = characterAttentionReason(row);
      return reason ? [[row.characterId, reason] as const] : [];
    }),
  );
}

// SPEC: 这个筛选必须与 Journey 的 Live x/3 使用同一套 Release placement、素材可用性与归属规则。
// INTENT: 它发生在 keyset 分页之前，不能拿当前页的客户端计数冒充完整运营清单。
async function incompleteLiveAssetPackCharacterIds(db: PrismaClient) {
  const live = await db.characterServing.findMany({
    where: { state: "live", currentReleaseId: { not: null } },
    select: { characterId: true, currentReleaseId: true },
  });
  const releaseIds = live.flatMap((row) =>
    row.currentReleaseId ? [row.currentReleaseId] : [],
  );
  if (releaseIds.length === 0) return [];
  const releases = await db.characterRelease.findMany({
    where: { id: { in: releaseIds } },
  });
  const releaseById = new Map(releases.map((release) => [release.id, release]));
  const packByCharacter = new Map(
    live.map((row) => [
      row.characterId,
      releaseAssetPack(
        row.currentReleaseId
          ? (releaseById.get(row.currentReleaseId) ?? null)
          : null,
      ),
    ]),
  );
  const candidateAssetIds = [
    ...new Set([...packByCharacter.values()].flatMap(assetIds)),
  ];
  const [assets, legacyCharacterReferences] =
    candidateAssetIds.length > 0
      ? await Promise.all([
          db.mediaAsset.findMany({
            where: operationalMediaAssetWhere({
              id: { in: candidateAssetIds },
              deletedAt: null,
              type: "image",
              safetyStatus: "passed",
            }),
            select: { id: true, characterId: true, metadata: true },
          }),
          db.character.findMany({
            where: { imageAssetId: { in: candidateAssetIds } },
            select: { id: true, imageAssetId: true },
          }),
        ])
      : [[], []];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const legacyReferencesByAsset = new Map<string, string[]>();
  for (const reference of legacyCharacterReferences) {
    if (!reference.imageAssetId) continue;
    const characterIds =
      legacyReferencesByAsset.get(reference.imageAssetId) ?? [];
    characterIds.push(reference.id);
    legacyReferencesByAsset.set(reference.imageAssetId, characterIds);
  }
  return live.flatMap(({ characterId }) => {
    const pack = packByCharacter.get(characterId) ?? {};
    const availableAssetIds = new Set(
      assetIds(pack).filter((assetId) => {
        const asset = assetById.get(assetId);
        if (!asset || !isMediaAssetOperationalForAuthority(asset.metadata)) {
          return false;
        }
        const legacyReferences = legacyReferencesByAsset.get(assetId) ?? [];
        return (
          asset.characterId === characterId ||
          (asset.characterId === null &&
            legacyReferences.length === 1 &&
            legacyReferences[0] === characterId)
        );
      }),
    );
    return availablePurposes(pack, availableAssetIds).length < 3
      ? [characterId]
      : [];
  });
}

// INVARIANT: equivalent to operationalCharacterWhere({ deletedAt: null }).
// The SQL population is shared by names, page rows and counts; it never expands
// all operational IDs into one bind parameter per Character.
export const operationalPortfolioCharacterSql = Prisma.sql`
  c."deletedAt" IS NULL AND (
    c.source = 'official' OR (
      c.source = 'user' AND EXISTS (
        SELECT 1 FROM "users" creator
        WHERE creator.id = c."creatorId"
          AND creator."dataClass" IN (${OPERATIONAL_USER_DATA_CLASS_SQL})
      )
    )
  )
`;

// SPEC: authoring names come from the same latest immutable draft as the editor,
// including readable v0/v1 history. Search also retains the live directory fields.
async function latestDraftNames(
  db: PrismaClient,
  characterIds: readonly string[] | null,
  search?: string,
) {
  if (characterIds?.length === 0) return [];
  return db.$queryRaw<Array<{ characterId: string; name: string | null }>>(Prisma.sql`
    SELECT "characterId", name FROM (
      SELECT c.id AS "characterId", c.name AS live_name, c.description AS live_description,
        COALESCE("personaSnapshot" #>> '{soul,name}', "personaSnapshot" #>> '{soul,identity,name}', "personaSnapshot" ->> 'name') AS name,
        COALESCE("personaSnapshot" #>> '{soul,characterPromise}', "personaSnapshot" #>> '{soul,identity,characterPromise}', "personaSnapshot" ->> 'description') AS description
      FROM "characters" c
      LEFT JOIN LATERAL (
        SELECT "personaSnapshot"
        FROM "character_content_versions"
        WHERE "characterId" = c.id
        ORDER BY version DESC LIMIT 1
      ) AS latest ON TRUE
      WHERE ${operationalPortfolioCharacterSql}
        ${characterIds === null ? Prisma.empty : Prisma.sql`AND c.id = ANY(${[...characterIds]}::text[])`}
    ) AS draft
    ${search ? Prisma.sql`WHERE
      strpos(lower(COALESCE(name, '')), lower(${search})) > 0 OR
      strpos(lower(COALESCE(description, '')), lower(${search})) > 0 OR
      strpos(lower("characterId"), lower(${search})) > 0 OR
      strpos(lower(live_name), lower(${search})) > 0 OR
      strpos(lower(live_description), lower(${search})) > 0` : Prisma.empty}
  `);
}

async function filteredCharacterIds(
  db: PrismaClient,
  query: CharacterPortfolioQuery,
  authorizedCharacterIds: readonly string[] | null = null,
  asOf: Date = new Date(),
) {
  const filters: string[][] = [];
  if (authorizedCharacterIds !== null) filters.push([...authorizedCharacterIds]);
  if (query.attention) filters.push([...(await attentionByCharacter(db, asOf)).keys()]);
  if (query.workQueue === "live_asset_pack_incomplete") {
    filters.push(await incompleteLiveAssetPackCharacterIds(db));
  } else if (query.workQueue) {
    filters.push([...(await workQueueCharacterIds(db, asOf))[query.workQueue]]);
  }
  if (query.search) {
    const drafts = await latestDraftNames(db, authorizedCharacterIds, query.search);
    filters.push(drafts.map((row) => row.characterId));
  }
  if (query.readiness) {
    const releases = await db.characterRelease.findMany({
      where: { readiness: query.readiness },
      select: { id: true },
    });
    filters.push(
      (
        await db.characterServing.findMany({
          where: { currentReleaseId: { in: releases.map((row) => row.id) } },
          select: { characterId: true },
        })
      ).map((row) => row.characterId),
    );
  }
  if (filters.length === 0) return null;
  return [
    ...filters.slice(1).reduce((current, ids) => {
      const allowed = new Set(ids);
      return new Set([...current].filter((id) => allowed.has(id)));
    }, new Set(filters[0])),
  ];
}

// SPEC: 运营排序 —— 每个值只用 character_projects 上的非空标量列，keyset 才成立。
// INTENT: 没有「blocked 优先」排序：readiness 来自 CharacterServing →
// CharacterRelease 两跳，不能提供稳定的项目表 keyset。要「先处理有问题的」用
// readiness=blocked 或 attention=true 先筛掉，
// 再按 updated_desc 排 —— 筛选跨页有效，排序只在页内有效。
const PORTFOLIO_ID_KEY: AdminKeysetKey<CharacterProject> = {
  field: "id",
  direction: "asc",
  value: (project) => project.id,
};
const PORTFOLIO_SORT_KEYS: Partial<Record<
  CharacterPortfolioQuery["sort"],
  readonly AdminKeysetKey<CharacterProject>[]
>> = {
  project_id_asc: [PORTFOLIO_ID_KEY],
  updated_desc: [
    {
      field: "updatedAt",
      direction: "desc",
      type: "datetime",
      value: (project) => project.updatedAt,
    },
    { ...PORTFOLIO_ID_KEY, direction: "desc" },
  ],
  updated_asc: [
    {
      field: "updatedAt",
      direction: "asc",
      type: "datetime",
      value: (project) => project.updatedAt,
    },
    PORTFOLIO_ID_KEY,
  ],
  created_desc: [
    {
      field: "createdAt",
      direction: "desc",
      type: "datetime",
      value: (project) => project.createdAt,
    },
    { ...PORTFOLIO_ID_KEY, direction: "desc" },
  ],
};

type PortfolioRow = CharacterProject & { readonly performanceSortValue?: number };

// SPEC: 表现排序键是 funnel 窗口聚合。keyset 要求键非空，率没有分母时取方向上的末尾值，
//       「没数据」永远排在有数据的后面，不会被读成最好或最差。
type FunnelSums = Readonly<Record<"qce" | "d7Pairs" | "d7Returns" | "impressions", Prisma.Sql>>;
function performanceSort(
  direction: "asc" | "desc",
  sql: (chatStarts: Prisma.Sql, sums: FunnelSums) => Prisma.Sql,
) {
  return {
    sql,
    keys: [
      {
        field: "performanceSortValue",
        direction,
        type: "number",
        value: (row: PortfolioRow) => Number(row.performanceSortValue),
      },
      { ...PORTFOLIO_ID_KEY, direction },
    ] as readonly AdminKeysetKey<PortfolioRow>[],
  };
}
function rateSort(
  direction: "asc" | "desc",
  numerator: (chatStarts: Prisma.Sql, sums: FunnelSums) => Prisma.Sql,
  denominator: (chatStarts: Prisma.Sql, sums: FunnelSums) => Prisma.Sql,
) {
  const missing = direction === "desc" ? Prisma.sql`-1` : Prisma.sql`2`;
  return performanceSort(direction, (chatStarts, sums) => Prisma.sql`
    COALESCE(${numerator(chatStarts, sums)}::float8 / NULLIF(${denominator(chatStarts, sums)}, 0)::float8, ${missing})::float8
  `);
}
const countSort = (
  direction: "asc" | "desc",
  value: (chatStarts: Prisma.Sql, sums: FunnelSums) => Prisma.Sql,
) => performanceSort(direction, (chatStarts, sums) => Prisma.sql`${value(chatStarts, sums)}::float8`);
const qceNumerator = (_: Prisma.Sql, sums: FunnelSums) => sums.qce;
const chatStartsValue = (chatStarts: Prisma.Sql) => chatStarts;
const d7Numerator = (_: Prisma.Sql, sums: FunnelSums) => sums.d7Returns;
const d7Denominator = (_: Prisma.Sql, sums: FunnelSums) => sums.d7Pairs;
const impressionsValue = (_: Prisma.Sql, sums: FunnelSums) => sums.impressions;
const PERFORMANCE_SORTS: Partial<Record<CharacterPortfolioQuery["sort"], ReturnType<typeof performanceSort>>> = {
  qce_rate_desc: rateSort("desc", qceNumerator, chatStartsValue),
  qce_rate_asc: rateSort("asc", qceNumerator, chatStartsValue),
  same_character_d7_desc: rateSort("desc", d7Numerator, d7Denominator),
  same_character_d7_asc: rateSort("asc", d7Numerator, d7Denominator),
  chat_starts_desc: countSort("desc", chatStartsValue),
  chat_starts_asc: countSort("asc", chatStartsValue),
  impressions_desc: countSort("desc", impressionsValue),
  impressions_asc: countSort("asc", impressionsValue),
};

// SPEC: 同类基线与平台下跌共用一份窗口聚合，一次查询，规模跟线上角色数走。
async function characterPeerFunnelRows(
  db: PrismaClient,
  asOf: Date,
  window: CharacterPerformanceWindow,
): Promise<CharacterPeerFunnelRow[]> {
  const { start, end } = completedUtcCharacterPerformanceWindow({ asOf, window });
  const priorStart = new Date(start.getTime() - (end.getTime() - start.getTime()));
  const inWindow = Prisma.sql`f."characterReleaseId" = s."currentReleaseId" AND f."productDay" >= ${start} AND f."productDay" < ${end}`;
  const inPrior = Prisma.sql`f."productDay" >= ${priorStart} AND f."productDay" < ${start}`;
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT c.id AS "characterId", c.style, c.gender,
      (release."publishedAt" IS NOT NULL AND release."publishedAt" <= ${start}) AS matured,
      COALESCE(SUM(f."eligibleImpressions") FILTER (WHERE ${inWindow}), 0)::int AS impressions,
      COALESCE(SUM(f."detailViews") FILTER (WHERE ${inWindow}), 0)::int AS "detailViews",
      COALESCE(SUM(f."firstSuccessfulExchanges") FILTER (WHERE ${inWindow}), 0)::int AS "chatStarts",
      COALESCE(SUM(f."qceCount") FILTER (WHERE ${inWindow}), 0)::int AS qce,
      COALESCE(SUM(f."sameCharacterD7EligiblePairs") FILTER (WHERE ${inWindow}), 0)::int AS "d7Pairs",
      COALESCE(SUM(f."sameCharacterD7Returns") FILTER (WHERE ${inWindow}), 0)::int AS "d7Returns",
      COALESCE(SUM(f."firstSuccessfulExchanges") FILTER (WHERE ${inPrior}), 0)::int AS "priorChatStarts",
      COALESCE(SUM(f."qceCount") FILTER (WHERE ${inPrior}), 0)::int AS "priorQce"
    FROM "character_serving" s
    JOIN "characters" c ON c.id = s."characterId"
    JOIN "character_releases" release ON release.id = s."currentReleaseId"
    LEFT JOIN "character_funnel_daily" f ON f."characterId" = c.id
      AND f."placementId" IS NULL AND f."metricVersion" = 1
      AND f."productDay" >= ${priorStart} AND f."productDay" < ${end}
    WHERE s.state = 'live' AND ${operationalPortfolioCharacterSql}
    GROUP BY c.id, c.style, c.gender, release."publishedAt"
  `);
  return rows as unknown as CharacterPeerFunnelRow[];
}

// SPEC: 各视图计数跟随搜索、来源与权限范围，不受视图自身筛选影响；分页前一次算清。
async function portfolioViewCounts(
  db: PrismaClient,
  scopeSql: Prisma.Sql,
  asOf: Date,
): Promise<CharacterPortfolioFacets["viewCounts"]> {
  const [attention, incomplete, queues] = await Promise.all([
    attentionByCharacter(db, asOf),
    incompleteLiveAssetPackCharacterIds(db),
    workQueueCharacterIds(db, asOf),
  ]);
  const within = (ids: Iterable<string>) => Prisma.sql`p."characterId" = ANY(${[...ids]}::text[])`;
  const state = Prisma.sql`COALESCE(s.state, 'inactive')`;
  const [row] = await db.$queryRaw<Array<CharacterPortfolioFacets["viewCounts"]>>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE ${state} <> 'retired')::int AS "all",
      COUNT(*) FILTER (WHERE ${state} = 'inactive')::int AS draft,
      COUNT(*) FILTER (WHERE ${state} = 'live')::int AS live,
      COUNT(*) FILTER (WHERE ${state} = 'paused')::int AS paused,
      COUNT(*) FILTER (WHERE ${state} = 'retired')::int AS archived,
      COUNT(*) FILTER (WHERE ${within(attention.keys())})::int AS attention,
      COUNT(*) FILTER (WHERE ${within(incomplete)})::int AS live_asset_pack_incomplete,
      COUNT(*) FILTER (WHERE ${within(queues.pending_changes)})::int AS pending_changes,
      COUNT(*) FILTER (WHERE ${within(queues.candidate_unpublished)})::int AS candidate_unpublished,
      COUNT(*) FILTER (WHERE ${within(queues.publish_blocked)})::int AS publish_blocked,
      COUNT(*) FILTER (WHERE ${within(queues.recent_generation_failed)})::int AS recent_generation_failed,
      COUNT(*) FILTER (WHERE ${within(queues.ready_to_publish)})::int AS ready_to_publish
    FROM "character_projects" p
    JOIN "characters" c ON c.id = p."characterId"
    LEFT JOIN "character_serving" s ON s."characterId" = p."characterId"
    WHERE ${scopeSql}
  `);
  return row;
}

const portfolioPageColumns: Record<string, Prisma.Sql> = {
  id: Prisma.sql`p.id`,
  updatedAt: Prisma.sql`p."updatedAt"`,
  createdAt: Prisma.sql`p."createdAt"`,
  performanceSortValue: Prisma.sql`metric.sort_value`,
};

// The existing paginator owns cursor validation and direction. This adapter only
// translates its fixed scalar predicates; SQL identifiers/operators stay allowlisted.
function portfolioPageSql(paging: AdminKeysetPaging) {
  const column = (field: string) => {
    if (!Object.hasOwn(portfolioPageColumns, field)) throw new Error("Unsupported Character portfolio cursor field");
    return portfolioPageColumns[field];
  };
  const groups = paging.cursorWhere.map((group) => {
    if (!Array.isArray(group.OR)) throw new Error("Unsupported Character portfolio cursor predicate");
    const clauses = group.OR.map((clause: Record<string, unknown>) => Prisma.sql`(${Prisma.join(
      Object.entries(clause).map(([field, operand]) => {
        if (typeof operand === "string" || typeof operand === "number" || operand instanceof Date) return Prisma.sql`${column(field)} = ${operand}`;
        if (operand === null || typeof operand !== "object" || Object.keys(operand).length !== 1) throw new Error("Unsupported Character portfolio cursor operand");
        if (Object.hasOwn(operand, "gt")) return Prisma.sql`${column(field)} > ${(operand as { gt: unknown }).gt}`;
        if (Object.hasOwn(operand, "lt")) return Prisma.sql`${column(field)} < ${(operand as { lt: unknown }).lt}`;
        throw new Error("Unsupported Character portfolio cursor comparison");
      }), " AND ",
    )})`);
    return Prisma.sql`(${Prisma.join(clauses, " OR ")})`;
  });
  const order = paging.orderBy.flatMap((entry) => Object.entries(entry).map(([field, direction]) => {
    if (direction !== "asc" && direction !== "desc") throw new Error("Unsupported Character portfolio sort direction");
    return Prisma.sql`${column(field)} ${direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`}`;
  }));
  return {
    cursor: groups.length ? Prisma.sql`AND ${Prisma.join(groups, " AND ")}` : Prisma.empty,
    order: Prisma.join(order),
  };
}

export async function listCharacterPortfolioData(
  db: PrismaClient,
  query: CharacterPortfolioQuery,
  input: {
    readonly asOf?: Date;
    readonly authorizedCharacterIds?: readonly string[] | null;
    readonly authorizedDraftAssetCharacterIds?: readonly string[] | null;
  } = {},
) {
  const asOf = input.asOf ?? new Date();
  // INTENT: release attribution costs roughly 20 queries per item and reads exposure facts
  // unbounded, so only a caller that renders it asks for it. The Admin list always states its mode.
  const includePerformance = query.includePerformance === true;
  const characterIds = await filteredCharacterIds(
    db,
    query,
    input.authorizedCharacterIds ?? null,
    asOf,
  );
  // INTENT: 没有 Serving 行的角色对外显示 inactive，筛选必须按同一口径，否则「草稿」视图漏人。
  const servingStateSql = Prisma.sql`COALESCE(s.state, 'inactive')`;
  const scopeSql = Prisma.sql`
    ${operationalPortfolioCharacterSql}
    ${characterIds === null ? Prisma.empty : Prisma.sql`AND p."characterId" = ANY(${characterIds}::text[])`}
    ${query.source ? Prisma.sql`AND c.source = ${query.source}` : Prisma.empty}
  `;
  const performanceSort = PERFORMANCE_SORTS[query.sort];
  const performanceWindow = completedUtcCharacterPerformanceWindow({ asOf, window: query.performanceWindow });
  const sortJoin = performanceSort ? Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT ${performanceSort.sql(Prisma.sql`COALESCE(SUM(f."firstSuccessfulExchanges"), 0)`, {
        qce: Prisma.sql`COALESCE(SUM(f."qceCount"), 0)`,
        d7Pairs: Prisma.sql`COALESCE(SUM(f."sameCharacterD7EligiblePairs"), 0)`,
        d7Returns: Prisma.sql`COALESCE(SUM(f."sameCharacterD7Returns"), 0)`,
        impressions: Prisma.sql`COALESCE(SUM(f."eligibleImpressions"), 0)`,
      })} AS sort_value
      FROM "character_funnel_daily" f
      WHERE f."characterId" = p."characterId"
        AND f."characterReleaseId" = s."currentReleaseId"
        AND f."placementId" IS NULL
        AND f."metricVersion" = 1
        AND f."productDay" >= ${performanceWindow.start}
        AND f."productDay" < ${performanceWindow.end}
    ) AS metric ON TRUE
  ` : Prisma.empty;
  const population = Prisma.sql`
    FROM "character_projects" p JOIN "characters" c ON c.id = p."characterId"
    LEFT JOIN "character_serving" s ON s."characterId" = p."characterId"
    ${sortJoin}
    WHERE ${scopeSql}
      ${query.servingState ? Prisma.sql`AND ${servingStateSql} = ${query.servingState}` : Prisma.empty}
      ${query.excludeArchived ? Prisma.sql`AND ${servingStateSql} <> 'retired'` : Prisma.empty}
      ${query.operating ? Prisma.sql`AND ${servingStateSql} IN ('live', 'paused')` : Prisma.empty}
  `;
  const { items: page, pageInfo } = await paginateAdminKeyset({
    scope: "character_portfolio",
    // 排序进 identity：换了排序，旧游标的键就对不上了，必须失效而不是静默错位。
    queryIdentity: {
      ...query,
      cursor: undefined,
      before: undefined,
      limit: undefined,
    },
    cursor: query.cursor,
    before: query.before,
    limit: query.limit,
    keys: performanceSort?.keys ?? PORTFOLIO_SORT_KEYS[query.sort] ?? [PORTFOLIO_ID_KEY],
    fetch: (paging: AdminKeysetPaging) => {
      const pageSql = portfolioPageSql(paging);
      return db.$queryRaw<PortfolioRow[]>(Prisma.sql`
        SELECT p.* ${performanceSort ? Prisma.sql`, metric.sort_value AS "performanceSortValue"` : Prisma.empty}
        ${population} ${pageSql.cursor}
        ORDER BY ${pageSql.order} LIMIT ${paging.take}
      `);
    },
    count: async () => {
      const [row] = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`SELECT COUNT(*)::int AS count ${population}`);
      return row.count;
    },
  });
  const pageCharacterIds = [
    ...new Set(page.map((project) => project.characterId)),
  ];
  const draftNameByCharacter = new Map(
    (await latestDraftNames(db, pageCharacterIds)).map((row) => [row.characterId, row.name]),
  );
  // INTENT: 页内也重查一次：attention=true 只说明「有原因」，卡片要的是具体哪一个原因。
  const pageAttention = await attentionByCharacter(db, asOf, pageCharacterIds);
  const peerRows = includePerformance
    ? await characterPeerFunnelRows(db, asOf, query.performanceWindow)
    : [];
  const peerBaselines = characterPeerBaselines(peerRows);
  const platformDecliners = characterPlatformDecliners(peerRows);
  const activeVisualAuthorities =
    pageCharacterIds.length > 0
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
  await Promise.all(
    pageCharacterIds.map(async (characterId) => {
      const authority = activeVisualAuthorityByCharacter.get(characterId);
      if (!authority) {
        qualifiedRouteByCharacter.set(characterId, null);
        return;
      }
      const roles =
        authority.referenceSetRevisions[0]?.references.map(
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
    }),
  );
  const [pageCharacters, rawPageCharacters, pageServings] =
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
  const currentReleaseIds = [
    ...new Set(
      pageServings.flatMap((serving) =>
        serving.currentReleaseId ? [serving.currentReleaseId] : [],
      ),
    ),
  ];
  const pageCurrentReleases =
    currentReleaseIds.length > 0
      ? await db.characterRelease.findMany({
          where: { id: { in: currentReleaseIds } },
        })
      : [];
  const currentReleaseById = new Map(
    pageCurrentReleases.map((release) => [release.id, release]),
  );
  const pageCandidateAssetIds = [
    ...new Set([
      ...page.flatMap((project) =>
        Object.values(draftAssetRouteEntries(project.draftAssetPack)).map(
          (entry) => entry.assetId,
        ),
      ),
      ...pageCurrentReleases.flatMap((release) =>
        characterReleasePlacements(release).map(
          (placement) => placement.assetId,
        ),
      ),
    ]),
  ];
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
      new Set(
        pageCandidateAssets.flatMap((asset) => {
          if (!isMediaAssetOperationalForAuthority(asset.metadata)) return [];
          const belongsToCharacter =
            asset.characterId === characterId ||
            (asset.characterId === null &&
              (characterReferencesByAssetId.get(asset.id) ?? []).length === 1 &&
              characterReferencesByAssetId.get(asset.id)?.[0] === characterId);
          return belongsToCharacter ? [asset.id] : [];
        }),
      ),
    ]),
  );
  const journeyByCharacter = await projectCharacterProductionJourneys(
    db,
    pageCharacterIds,
    asOf,
    {
      routeByCharacter: qualifiedRouteByCharacter,
      availableAssetIdsByCharacter,
    },
  );
  const orphanProjectIds: string[] = [];
  const projectedItems = await Promise.all(
    page.map(async (project) => {
      const character = pageCharacterById.get(project.characterId) ?? null;
      const serving = pageServingByCharacter.get(project.characterId) ?? null;
      if (!character) {
        if (!rawPageCharacterIds.has(project.characterId)) {
          orphanProjectIds.push(project.id);
        }
        return null;
      }
      const currentRelease = serving?.currentReleaseId
        ? (currentReleaseById.get(serving.currentReleaseId) ?? null)
        : null;
      const previousRelease = currentRelease && includePerformance
        ? currentRelease.supersedesId
          ? await db.characterRelease.findUnique({
              where: { id: currentRelease.supersedesId },
            })
          : await db.characterRelease.findFirst({
              where: {
                projectId: project.id,
                id: { not: currentRelease.id },
                status: { in: ["published", "superseded"] },
                publishedAt: currentRelease.publishedAt
                  ? { lt: currentRelease.publishedAt }
                  : undefined,
              },
              orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
            })
        : null;
      const availablePlacements = currentRelease
        ? [
            ...new Set([
              null,
              ...characterReleasePlacements(currentRelease).map(
                (placement) => placement.slotKey,
              ),
            ]),
          ]
        : [];
      const placements = query.aggregateOnly
        ? [null]
        : query.placementId
          ? availablePlacements.filter(
              (placementId) => placementId === query.placementId,
            )
          : availablePlacements;
      const performance = currentRelease && includePerformance
        ? await Promise.all(
            placements.flatMap((placementId) =>
              (["7d", "28d"] as const).map((window) =>
                performanceSummary(db, {
                  characterId: project.characterId,
                  release: currentRelease,
                  placementId,
                  window,
                  asOf,
                }),
              ),
            ),
          )
        : [];
      const validation = currentRelease
        ? await db.releaseValidationRun.findFirst({
            where: { releaseId: currentRelease.id },
            orderBy: { startedAt: "desc" },
          })
        : null;
      const readiness =
        currentRelease &&
        ["ready", "blocked", "stale", "unknown"].includes(
          currentRelease.readiness,
        )
          ? (currentRelease.readiness as
              "ready" | "blocked" | "stale" | "unknown")
          : ("unknown" as const);
      const qualifiedRoute =
        qualifiedRouteByCharacter.get(project.characterId) ?? null;
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
      const candidateAssetIds = [
        ...new Set([...assetIds(draftAssetPack), ...assetIds(liveAssetPack)]),
      ];
      const candidateAssets = candidateAssetIds.flatMap((assetId) => {
        const asset = pageCandidateAssetById.get(assetId);
        return asset ? [asset] : [];
      });
      const availableAssets = new Map(
        candidateAssets.flatMap((asset) => {
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
            (asset.characterId === null &&
              exactCharacterReferences.length === 1 &&
              exactCharacterReferences[0] === character.id);
          return ownershipMatches &&
            imageUrl !== null &&
            isMediaAssetOperationalForAuthority(asset.metadata)
            ? [[asset.id, { ...asset, imageUrl }] as const]
            : [];
        }),
      );
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
      const primaryImageSource =
        primaryImageAssetId === draftPortraitAssetId
          ? ("draft" as const)
          : primaryImageAssetId
            ? ("live" as const)
            : null;
      const primaryImageAsset = primaryImageAssetId
        ? (availableAssets.get(primaryImageAssetId) ?? null)
        : null;
      const journey = journeyByCharacter.get(character.id);
      if (!journey) {
        throw new Error(
          `Character production journey missing for ${character.id}`,
        );
      }
      const draftPurposes = mayReadDraftAssets
        ? journey.assetPack.draft.availablePurposes
        : [];
      const livePurposes = journey.assetPack.live.availablePurposes;
      return {
        characterId: character.id,
        name: draftNameByCharacter.get(character.id) || character.name,
        source: character.source,
        visibility: character.visibility,
        updatedAt: project.updatedAt.toISOString(),
        needsAttention: pageAttention.has(character.id),
        attentionReason: pageAttention.get(character.id) ?? null,
        serving: {
          characterId: character.id,
          state: serving?.state ?? "inactive",
          currentReleaseId: serving?.currentReleaseId ?? null,
          version: serving?.version ?? 0,
          updatedAt: (serving?.updatedAt ?? project.updatedAt).toISOString(),
        },
        currentRelease: currentRelease
          ? characterReleaseContract(currentRelease)
          : null,
        readiness,
        verificationState:
          validation?.result === "passed"
            ? "passed"
            : validation
              ? "failed"
              : "pending",
        performance,
        changeMarkers: currentRelease && includePerformance
          ? await changeMarkers(
              db,
              character.id,
              currentRelease,
              previousRelease,
              asOf,
            )
          : [],
        recommendation: currentRelease && includePerformance
          ? characterPerformanceRecommendation({
              window: query.performanceWindow,
              summary:
                performance.find(
                  (row) => row.window === query.performanceWindow && row.placementId === null,
                ) ?? null,
              baseline: peerBaselines.get(peerKey(character)) ?? null,
              servingState: serving?.state ?? "inactive",
              declinedWithPlatform: platformDecliners.has(character.id),
            })
          : null,
        visualProduction: {
          primaryImageUrl: primaryImageAsset?.imageUrl ?? null,
          primaryImageSource: primaryImageAsset ? primaryImageSource : null,
          draftPurposes,
          livePurposes,
          totalPurposes: 3,
          deepLink: characterWorkspaceTabLink(character.id, "assets"),
        },
        journey,
        operationalState: {
          workflowState: journey.stage,
          servingState: serving?.state ?? "inactive",
          // SPEC: 汇总取最坏，但"全是无观测"要报 no_data，不能借 invalid 冒充数据故障。
          // INVARIANT: 空的 performance 数组也是 no_data —— 一条观测都没有，
          //   不构成"已认证"。此前的判据要求 `performance.length > 0` 才判 no_data，
          //   于是零表现行反而落进 certified 分支（实测 33 个角色里 14 个如此，
          //   且这 14 个全部 performance: []）。`every` 对空数组恒真，
          //   所以去掉长度前置条件就能同时覆盖两种情况。
          qualityState: !includePerformance ? "not_requested" : performance.some(
            (item) => item.qualityState === "invalid",
          )
            ? "invalid"
            : performance.every((item) => item.qualityState === "no_data")
              ? "no_data"
              : "certified",
          readiness,
          checks: [],
          blockers:
            readiness === "ready"
              ? []
              : [
                  {
                    code: `release_${readiness}`,
                    message: `Current release readiness is ${readiness}`,
                    deepLink: characterWorkspaceTabLink(
                      character.id,
                      "monitor",
                    ),
                  },
                ],
          verificationState:
            validation?.result === "passed"
              ? "passed"
              : validation
                ? "failed"
                : "pending",
          policyVersion:
            validation?.policyVersion ?? "character-release-policy-v1",
          entityVersion: currentRelease?.version ?? project.version,
          lastVerifiedAt: validation?.finishedAt?.toISOString() ?? null,
        },
      };
    }),
  );
  const items = projectedItems.filter(
    (item): item is Exclude<typeof item, null> => item !== null,
  );
  const dataQuality: Array<{
    code: string;
    severity: "warning" | "error";
    message: string;
  }> = [
    {
      code: "character_margin_payment_authority_unavailable",
      severity: "warning",
      message:
        "Contribution margin is invalid until captured cash, refund, credit, and character attribution authorities are available.",
    },
  ];
  if (orphanProjectIds.length > 0) {
    dataQuality.push({
      code: "character_project_orphan",
      severity: "error",
      message: `${orphanProjectIds.length} Character Project row(s) on this page have no Character authority and were excluded; cutover is blocked until reconciliation.`,
    });
  }
  return characterPortfolioResponseSchema.parse({
    items,
    pageInfo,
    ...(query.includeFacets
      ? {
          facets: {
            viewCounts: await portfolioViewCounts(db, scopeSql, asOf),
          },
        }
      : {}),
    asOf: asOf.toISOString(),
    freshness: orphanProjectIds.length > 0 ? "degraded" : "fresh",
    dataQuality,
  });
}

export async function listCharacterPortfolio(request: Request) {
  const actor = await actorWithPermission(
    request,
    "character.performance.read",
  );
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
  return ok(
    await listCharacterPortfolioData(prisma, query, {
      authorizedCharacterIds: scope === null ? null : [...scope],
      authorizedDraftAssetCharacterIds:
        draftAssetScope === null ? null : [...draftAssetScope],
    }),
    { headers: { "cache-control": "no-store" } },
  );
}
