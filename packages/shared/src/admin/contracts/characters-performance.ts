// SPEC: Character performance — contribution margin, performance windows,
// Character listing, production journey, backfill and reconciliation.

import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminControlPlaneCommandStatusSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminReadinessSchema,
  adminVerificationStateSchema,
  operationalStateViewSchema,
} from "./common";
import { characterServingStateSchema } from "./characters-common";
import {
  characterReleaseSchema,
  characterServingSchema,
} from "./characters-release";

export const characterPerformanceWindowSchema = z.enum(["7d", "28d"]);

export const characterPerformanceMaturitySchema = z.enum([
  "mature",
  "immature",
  "insufficient_data",
]);

// SPEC: no_data = 窗口内一条观测都没有；invalid = 有观测但口径不可信（漏斗倒挂、曝光链断裂）。
// INTENT: 两者都必须 fail closed（rate=null），但运营动作完全相反——no_data 是等，invalid 是查。
// 压成同一个值会让每个新上线角色天天报"数据不可用"，真故障时运营已经学会无视这个字段了。
export const characterPerformanceQualitySchema = z.enum([
  "certified",
  "directional",
  "invalid",
  "no_data",
]);

export const characterContributionMarginSchema = z
  .object({
    valueMicros: z.number().int().nullable(),
    currency: z.string().trim().length(3).nullable(),
    attributedRevenueMicros: z.number().int().nonnegative().nullable(),
    refundMicros: z.number().int().nonnegative().nullable(),
    creditMicros: z.number().int().nonnegative().nullable(),
    variableCostMicros: z.number().int().nonnegative().nullable(),
    qualityState: characterPerformanceQualitySchema,
    evidence: z.array(z.string().trim().min(1)).min(1).readonly(),
  })
  .strict()
  .superRefine((margin, ctx) => {
    if (margin.qualityState === "invalid" && margin.valueMicros !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["valueMicros"],
        message:
          "Invalid contribution margin must fail closed with valueMicros=null",
      });
    }
    if (margin.valueMicros !== null && margin.currency === null) {
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "A contribution margin value requires an audited currency",
      });
    }
  });

const nullableRateSchema = z.number().min(0).max(1).nullable();

export const characterPerformanceSummarySchema = z
  .object({
    characterContentVersionId: adminIdSchema,
    characterReleaseId: adminIdSchema,
    placementId: adminIdSchema.nullable(),
    window: characterPerformanceWindowSchema,
    windowStart: adminIsoDateTimeSchema,
    windowEnd: adminIsoDateTimeSchema,
    eligibleImpressions: z.number().int().nonnegative(),
    detailViews: z.number().int().nonnegative(),
    firstSuccessfulExchanges: z.number().int().nonnegative(),
    qceCount: z.number().int().nonnegative(),
    relationshipActivations: z.number().int().nonnegative(),
    sameCharacterD7EligiblePairs: z.number().int().nonnegative(),
    sameCharacterD7Returns: z.number().int().nonnegative(),
    paidAttributions: z.number().int().nonnegative(),
    detailCtr: nullableRateSchema,
    chatStartRate: nullableRateSchema,
    qceRate: nullableRateSchema,
    sameCharacterD7: nullableRateSchema,
    sampleSize: z.number().int().nonnegative(),
    maturity: characterPerformanceMaturitySchema,
    qualityState: characterPerformanceQualitySchema,
    coverageState: z.enum(["exact", "partial", "unavailable", "invalid"]),
    latestDataAt: adminIsoDateTimeSchema.nullable(),
    evidence: z.array(z.string().trim().min(1)).min(1).readonly(),
    contributionMargin: characterContributionMarginSchema,
  })
  .strict()
  .superRefine((summary, ctx) => {
    const explicitInvalidCohortDiagnostic =
      summary.qualityState === "invalid" &&
      summary.coverageState === "invalid" &&
      summary.evidence.includes("numerator_outside_denominator_cohort");
    const cohortPairs: ReadonlyArray<readonly [number, number, string]> = [
      [summary.detailViews, summary.eligibleImpressions, "detailViews"],
      [
        summary.firstSuccessfulExchanges,
        summary.detailViews,
        "firstSuccessfulExchanges",
      ],
      [summary.qceCount, summary.firstSuccessfulExchanges, "qceCount"],
      [
        summary.sameCharacterD7Returns,
        summary.sameCharacterD7EligiblePairs,
        "sameCharacterD7Returns",
      ],
    ];
    for (const [numerator, denominator, field] of cohortPairs) {
      if (numerator > denominator && !explicitInvalidCohortDiagnostic) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Numerator must belong to the denominator cohort",
        });
      }
    }
    if (
      summary.qualityState === "invalid" ||
      summary.qualityState === "no_data"
    ) {
      for (const field of [
        "detailCtr",
        "chatStartRate",
        "qceRate",
        "sameCharacterD7",
      ] as const) {
        if (summary[field] !== null) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Unusable performance must fail closed with rate=null",
          });
        }
      }
    }
    if (
      summary.qualityState === "no_data" &&
      summary.coverageState !== "unavailable"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["coverageState"],
        message: "no_data quality must report unavailable coverage",
      });
    }
  });

export const characterReleaseChangeMarkerSchema = z
  .object({
    currentReleaseId: adminIdSchema,
    previousReleaseId: adminIdSchema.nullable(),
    changedAt: adminIsoDateTimeSchema,
    window: characterPerformanceWindowSchema,
    comparable: z.boolean(),
    // SPEC: QCE/D7 对比接受 directional（付费归因不可用但曝光链精确）并如实标注；毛利仍只认 certified。
    comparisonQuality: z.enum(["certified", "directional"]).nullable(),
    qceRateDelta: z.number().min(-1).max(1).nullable(),
    sameCharacterD7Delta: z.number().min(-1).max(1).nullable(),
    contributionMarginDeltaMicros: z.number().int().nullable(),
    evidence: z.array(z.string().trim().min(1)).min(1).readonly(),
  })
  .strict()
  .superRefine((marker, ctx) => {
    if (
      !marker.comparable &&
      [
        marker.qceRateDelta,
        marker.sameCharacterD7Delta,
        marker.contributionMarginDeltaMicros,
      ].some((value) => value !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["comparable"],
        message: "Non-comparable release changes cannot expose numeric deltas",
      });
    }
    if (marker.comparable !== (marker.comparisonQuality !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["comparisonQuality"],
        message: "A comparable release change must state its comparison quality",
      });
    }
  });

export const characterPortfolioVisualProductionSchema = z
  .object({
    primaryImageUrl: z.string().trim().min(1).nullable(),
    primaryImageSource: z.enum(["draft", "live"]).nullable(),
    draftPurposes: z
      .array(z.enum(["character_cover", "character_hero", "character_chat"]))
      .max(3)
      .readonly(),
    livePurposes: z
      .array(z.enum(["character_cover", "character_hero", "character_chat"]))
      .max(3)
      .readonly(),
    totalPurposes: z.literal(3),
    deepLink: z.string().startsWith("/admin/characters/"),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ["draftPurposes", "livePurposes"] as const) {
      if (new Set(value[key]).size !== value[key].length) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Role-image purposes must be unique",
        });
      }
    }
    if (
      (value.primaryImageUrl === null) !==
      (value.primaryImageSource === null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryImageSource"],
        message: "Primary role-image source must match image availability",
      });
    }
    if (
      value.primaryImageSource === "draft" &&
      !value.draftPurposes.includes("character_cover")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["draftPurposes"],
        message: "A draft primary image requires an available draft cover",
      });
    }
    if (
      value.primaryImageSource === "live" &&
      !value.livePurposes.includes("character_cover")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["livePurposes"],
        message: "A live primary image requires an available live cover",
      });
    }
  });

export const characterProductionActionCodeSchema = z.enum([
  "recover_active_command",
  "create_primary_portrait",
  "prepare_image_production",
  "complete_image_route",
  // SPEC: 路线不合格是平台配置问题，运营在角色页修不了；入口是平台运维的 Profiles & Rollout。
  "platform_route_unavailable",
  "continue_image_run",
  "retry_failed_image_run",
  "resolve_unknown_image_run",
  "continue_asset_pack",
  "repair_character_soul",
  "preview_character",
  "publish_character",
  "monitor_live_character",
]);

const characterProductionPurposeSchema = z.enum([
  "character_cover",
  "character_hero",
  "character_chat",
]);

const characterProductionAssetPackProgressSchema = z
  .object({
    availablePurposes: z
      .array(characterProductionPurposeSchema)
      .max(3)
      .readonly(),
    missingPurposes: z
      .array(characterProductionPurposeSchema)
      .max(3)
      .readonly(),
    completed: z.number().int().min(0).max(3),
    total: z.literal(3),
  })
  .strict()
  .superRefine((progress, ctx) => {
    const available = new Set(progress.availablePurposes);
    const missing = new Set(progress.missingPurposes);
    if (
      available.size !== progress.availablePurposes.length ||
      missing.size !== progress.missingPurposes.length ||
      [...available].some((purpose) => missing.has(purpose)) ||
      available.size + missing.size !== progress.total ||
      progress.completed !== available.size
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["availablePurposes"],
        message:
          "Asset-pack progress must partition the three canonical purposes",
      });
    }
  });

export const characterProductionJourneySchema = z
  .object({
    projectionVersion: z.literal(1),
    asOf: adminIsoDateTimeSchema,
    stage: z.enum([
      "visual_setup",
      "image_production",
      "preview",
      "publishing",
      "live_operations",
    ]),
    status: z.enum(["blocked", "in_progress", "ready", "live"]),
    steps: z
      .tuple([
        z
          .object({
            code: z.literal("visual_identity"),
            state: z.enum(["complete", "current", "upcoming", "blocked"]),
            deepLink: z.string().startsWith("/admin/characters/"),
          })
          .strict(),
        z
          .object({
            code: z.literal("image_assets"),
            state: z.enum(["complete", "current", "upcoming", "blocked"]),
            deepLink: z.string().startsWith("/admin/characters/"),
          })
          .strict(),
        z
          .object({
            code: z.literal("preview"),
            state: z.enum(["complete", "current", "upcoming", "blocked"]),
            deepLink: z.string().startsWith("/admin/characters/"),
          })
          .strict(),
        z
          .object({
            code: z.literal("release"),
            state: z.enum(["complete", "current", "upcoming", "blocked"]),
            deepLink: z.string().startsWith("/admin/characters/"),
          })
          .strict(),
        z
          .object({
            code: z.literal("live_monitor"),
            state: z.enum(["complete", "current", "upcoming", "blocked"]),
            deepLink: z.string().startsWith("/admin/characters/"),
          })
          .strict(),
      ])
      .readonly(),
    blockers: z
      .array(
        z
          .object({
            code: z.string().trim().min(1),
            message: z.string().trim().min(1),
            deepLink: z.string().startsWith("/admin/"),
          })
          .strict(),
      )
      .readonly(),
    primaryAction: z
      .object({
        code: characterProductionActionCodeSchema,
        deepLink: z.string().startsWith("/admin/"),
        command: z
          .object({
            id: adminIdSchema,
            type: z.string().trim().min(1),
            status: adminControlPlaneCommandStatusSchema,
            needsReconciliation: z.boolean(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    assetPack: z
      .object({
        draft: characterProductionAssetPackProgressSchema,
        live: characterProductionAssetPackProgressSchema,
      })
      .strict(),
    release: z
      .object({
        servingState: characterServingStateSchema,
        currentReleaseId: adminIdSchema.nullable(),
        candidateReleaseId: adminIdSchema.nullable(),
        // SPEC: a Revision newer than the one the current Release pins — e.g. the
        // creator edited a published Character. Null when nothing is waiting.
        pendingRevision: z
          .object({
            revisionId: adminIdSchema,
            revision: z.number().int().positive(),
            createdAt: adminIsoDateTimeSchema,
            deepLink: z.string().startsWith("/admin/characters/"),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

// SPEC: 列表「需要处理」与 Today 的角色待办共用这一组原因，不存在第二套状态。
export const characterAttentionReasonSchema = z.enum([
  "release_monitor_action",
  "no_traffic_after_window",
]);

export const characterRecommendationSchema = z.enum([
  "promote",
  "maintain",
  "improve",
  "pause",
  "retire",
  "insufficient_data",
]);

export const characterRecommendationReasonSchema = z.enum([
  "window_immature",
  "sample_insufficient",
  "data_invalid",
  "no_peer_baseline",
  "platform_wide_decline",
  "low_ctr_high_retention",
  "high_starts_low_qce",
  "high_qce_low_d7",
  "low_qce",
  "low_d7",
  "outperforming_peers",
  "severely_underperforming",
  "persistently_underperforming",
  "in_line_with_peers",
]);

const characterRecommendationTabSchema = z.enum([
  "project",
  "soul",
  "visual",
  "assets",
  "video",
  "voice",
  "preview",
  "release",
  "monitor",
]);

// SPEC: 只是建议，绝不自动执行或自动淘汰；未成熟或样本不足只会是 insufficient_data。
export const characterPerformanceRecommendationSchema = z
  .object({
    window: characterPerformanceWindowSchema,
    recommendation: characterRecommendationSchema,
    reasonCode: characterRecommendationReasonSchema,
    // null = 问题不在单个角色上（平台普遍下跌），由 Admin 指向事故页。
    targetTab: characterRecommendationTabSchema.nullable(),
    baseline: z
      .object({
        peerCount: z.number().int().positive(),
        detailCtr: nullableRateSchema,
        chatStartRate: nullableRateSchema,
        qceRate: nullableRateSchema,
        sameCharacterD7: nullableRateSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const characterPortfolioItemSchema = z
  .object({
    characterId: adminIdSchema,
    name: z.string().trim().min(1),
    source: z.enum(["official", "user"]),
    visibility: z.string().trim().min(1),
    updatedAt: adminIsoDateTimeSchema,
    // SPEC: true = 当前 Release 的监控要求处置，或线上已走完 7 天观察窗却真的零流量
    //       （无曝光、无漏斗、无合格聊天）。
    // INTENT: 这个事实必须跟着每张卡片返回；只把它藏在 attention=true 筛选里，普通列表
    //         就会让一个偶然存在的图片批次盖过真实线上故障。
    needsAttention: z.boolean(),
    attentionReason: characterAttentionReasonSchema.nullable(),
    serving: characterServingSchema,
    currentRelease: characterReleaseSchema.nullable(),
    readiness: adminReadinessSchema,
    verificationState: adminVerificationStateSchema.optional(),
    performance: z.array(characterPerformanceSummarySchema).readonly(),
    changeMarkers: z.array(characterReleaseChangeMarkerSchema).readonly(),
    recommendation: characterPerformanceRecommendationSchema.nullable(),
    visualProduction: characterPortfolioVisualProductionSchema,
    journey: characterProductionJourneySchema,
    operationalState: operationalStateViewSchema,
  })
  .strict();

export const characterPortfolioWorkQueueSchema = z.enum([
  "live_asset_pack_incomplete",
  "pending_changes",
  "candidate_unpublished",
  "publish_blocked",
  "recent_generation_failed",
  "ready_to_publish",
]);

export const characterPortfolioSortSchema = z.enum([
  "project_id_asc",
  "updated_desc",
  "updated_asc",
  "created_desc",
  "qce_rate_desc",
  "qce_rate_asc",
  "same_character_d7_desc",
  "same_character_d7_asc",
  "chat_starts_desc",
  "chat_starts_asc",
  "impressions_desc",
  "impressions_asc",
]);

const booleanQuerySchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const characterPortfolioQuerySchema = adminCursorQuerySchema.extend({
  // 反向翻页：把上一页响应里的 startCursor 原样回传。与 cursor 互斥。
  before: z.string().trim().min(1).optional(),
  servingState: characterServingStateSchema.optional(),
  readiness: adminReadinessSchema.optional(),
  placementId: adminIdSchema.optional(),
  // Studio needs lifecycle and asset readiness; Growth explicitly consumes metrics.
  includePerformance: booleanQuerySchema.optional(),
  // SPEC: attention 只收「当前 Release 监控要求处置」与「已上线但整个观察窗口真的零流量」。
  // 故意不含资产包不完整（Journey 已经在说）——多收一条就把这个筛子稀释成恒真告警。
  // INTENT: 做成筛选而不是排序 —— 列表是 keyset 分页，排序只在页内生效，第三页的问题角色照样发现不了。
  // 不用 z.coerce.boolean()：它把 "false" 也当真，一个筛不掉的筛子比没有更糟。
  attention: booleanQuerySchema.optional(),
  // SPEC: 运营工作清单是服务端筛选，必须跨页完整；判定与卡片上的 Journey 同源。
  // INTENT: 不把它们并入 attention。零观测与补图、发布是不同判断、不同处置入口。
  workQueue: characterPortfolioWorkQueueSchema.optional(),
  source: z.enum(["official", "user"]).optional(),
  // INTENT: 默认全量不变（角色详情要能读到已归档角色）；列表的「全部」视图显式排除归档，
  //         归档草稿不再因为 updatedAt 新而排在最前。
  excludeArchived: booleanQuerySchema.optional(),
  // SPEC: 表现页默认范围：live + paused。与 servingState 同时给时取交集。
  operating: booleanQuerySchema.optional(),
  // SPEC: 排序与建议使用的窗口；performance 数组仍带 7d 与 28d。
  performanceWindow: characterPerformanceWindowSchema.default("28d"),
  // INTENT: 表现页只比较全铺位聚合。逐铺位的 performance 行每行多 4 个查询，页面用不上就别付。
  aggregateOnly: booleanQuerySchema.optional(),
  // SPEC: 各视图的精确计数在分页前算一次；角色详情等调用方不需要，不付这个代价。
  includeFacets: booleanQuerySchema.optional(),
  // SPEC: keyset 分页要求排序键可比较且不为 NULL。readiness / journey stage 都是跨表推导
  // 出来的，没有可排序的列，想「先处理 blocked」用 workQueue 或 attention 筛，再按 updated 排。
  // 表现排序键是 funnel 窗口聚合：率没有分母时落到方向上的末尾，不把「没数据」排成最差或最好。
  sort: characterPortfolioSortSchema.default("updated_desc"),
});

// SPEC: 视图计数不受视图自身筛选影响，只跟随搜索、来源和权限范围。
export const characterPortfolioFacetsSchema = z
  .object({
    viewCounts: z
      .object({
        all: z.number().int().nonnegative(),
        draft: z.number().int().nonnegative(),
        live: z.number().int().nonnegative(),
        paused: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative(),
        attention: z.number().int().nonnegative(),
        live_asset_pack_incomplete: z.number().int().nonnegative(),
        pending_changes: z.number().int().nonnegative(),
        candidate_unpublished: z.number().int().nonnegative(),
        publish_blocked: z.number().int().nonnegative(),
        recent_generation_failed: z.number().int().nonnegative(),
        ready_to_publish: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const characterPortfolioResponseSchema = adminListResponseSchema(
  characterPortfolioItemSchema,
).extend({ facets: characterPortfolioFacetsSchema.optional() });

export const characterOperationsSummaryQuerySchema = z
  .object({ window: characterPerformanceWindowSchema.default("7d") })
  .strict();

// SPEC: 运营效能只读汇总，全部从已提交事实查询。null = 暂无证据，不是 0。
export const characterOperationsSummarySchema = z
  .object({
    window: characterPerformanceWindowSchema,
    windowStart: adminIsoDateTimeSchema,
    windowEnd: adminIsoDateTimeSchema,
    firstUsableImage: z
      .object({
        medianHours: z.number().nonnegative().nullable(),
        sampleSize: z.number().int().nonnegative(),
      })
      .strict(),
    createToFirstPublish: z
      .object({
        medianHours: z.number().nonnegative().nullable(),
        sampleSize: z.number().int().nonnegative(),
      })
      .strict(),
    imageAdoption: z
      .object({
        adopted: z.number().int().nonnegative(),
        generated: z.number().int().nonnegative(),
        rate: nullableRateSchema,
      })
      .strict(),
    adoptedImageCost: z
      .object({
        // 只有窗口内每次 provider 调用都有真实成本时才给值；否则 null，不用部分成本冒充。
        microsPerAdoptedImage: z.number().nonnegative().nullable(),
        currency: z.literal("USD"),
        coverage: z.enum(["complete", "partial", "none"]),
      })
      .strict(),
    // INTENT: prepare 被拒随事务回滚，没有留下事实；这里只数已提交的发布命令失败。
    publishFailures: z
      .object({
        count: z.number().int().nonnegative(),
        coverage: z.literal("committed_commands_only"),
      })
      .strict(),
    operationCount: z.number().int().nonnegative(),
  })
  .strict();

export const characterPerformanceBackfillRequestSchema = z
  .object({
    source: z.string().trim().min(1).max(120),
    kind: z.enum(["funnel", "variable_cost"]),
    dryRun: z.boolean().default(true),
    batchSize: z.number().int().min(1).max(1_000).default(200),
    cursor: z.string().trim().min(1).nullable().default(null),
  })
  .strict();

export const characterPerformanceBackfillResponseSchema = z
  .object({
    runId: adminIdSchema,
    status: z.enum(["paused", "completed"]),
    dryRun: z.boolean(),
    scannedCount: z.number().int().nonnegative(),
    wouldApplyCount: z.number().int().nonnegative(),
    appliedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    mismatchCount: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
    before: z.record(z.string(), z.number().int().nonnegative()),
    after: z.record(z.string(), z.number().int().nonnegative()),
    mismatches: z.array(z.record(z.string(), z.unknown())).readonly(),
  })
  .strict();

export const characterPerformanceReconciliationSchema = z
  .object({
    scannedFunnelRows: z.number().int().nonnegative(),
    impossibleFunnelRows: z.number().int().nonnegative(),
    missingReleaseRows: z.number().int().nonnegative(),
    nonExactFunnelRows: z.number().int().nonnegative(),
    relevantCostAuthorities: z.number().int().nonnegative(),
    projectedCostAuthorities: z.number().int().nonnegative(),
    missingVariableCostFacts: z.number().int().nonnegative(),
    unauditedEconomicsFacts: z.number().int().nonnegative(),
    partialEconomicsFacts: z.number().int().nonnegative(),
    cashRevenueAuthorityState: z.literal("unavailable"),
    refundAuthorityState: z.literal("unavailable"),
    creditAuthorityState: z.literal("unavailable"),
    qualityState: z.enum(["directional", "invalid"]),
  })
  .strict();

export type CharacterPortfolioItem = z.infer<
  typeof characterPortfolioItemSchema
>;

export type CharacterPortfolioFacets = z.infer<
  typeof characterPortfolioFacetsSchema
>;

export type CharacterPerformanceRecommendation = z.infer<
  typeof characterPerformanceRecommendationSchema
>;

export type CharacterOperationsSummary = z.infer<
  typeof characterOperationsSummarySchema
>;

export type CharacterProductionJourney = z.infer<
  typeof characterProductionJourneySchema
>;

export type CharacterPortfolioQuery = z.infer<
  typeof characterPortfolioQuerySchema
>;

export type CharacterPerformanceSummary = z.infer<
  typeof characterPerformanceSummarySchema
>;

export type CharacterPerformanceWindow = z.infer<
  typeof characterPerformanceWindowSchema
>;

export type CharacterContributionMargin = z.infer<
  typeof characterContributionMarginSchema
>;

export type CharacterPerformanceBackfillRequest = z.infer<
  typeof characterPerformanceBackfillRequestSchema
>;

export type CharacterPerformanceReconciliation = z.infer<
  typeof characterPerformanceReconciliationSchema
>;
