// SPEC: Character performance and portfolio — contribution margin, performance windows,
// portfolio listing/decisions, production journey, backfill and reconciliation.

import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminControlPlaneCommandStatusSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPrioritySchema,
  adminReadinessSchema,
  adminVerificationStateSchema,
  operationalStateViewSchema,
} from "./common";
import {
  characterProjectPhaseSchema,
  characterServingStateSchema,
} from "./characters-common";
import {
  characterProjectSchema,
} from "./characters-create";
import {
  characterReleaseSchema,
  characterServingSchema,
} from "./characters-release";

export const characterPortfolioDecisionSchema = z.enum([
  "Promote",
  "Maintain",
  "Improve",
  "Pause",
  "Retire",
]);

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
        message: "Invalid contribution margin must fail closed with valueMicros=null",
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
      [summary.firstSuccessfulExchanges, summary.detailViews, "firstSuccessfulExchanges"],
      [summary.qceCount, summary.firstSuccessfulExchanges, "qceCount"],
      [summary.sameCharacterD7Returns, summary.sameCharacterD7EligiblePairs, "sameCharacterD7Returns"],
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
    if (summary.qualityState === "invalid" || summary.qualityState === "no_data") {
      for (const field of ["detailCtr", "chatStartRate", "qceRate", "sameCharacterD7"] as const) {
        if (summary[field] !== null) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Unusable performance must fail closed with rate=null",
          });
        }
      }
    }
    if (summary.qualityState === "no_data" && summary.coverageState !== "unavailable") {
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
    qceRateDelta: z.number().min(-1).max(1).nullable(),
    sameCharacterD7Delta: z.number().min(-1).max(1).nullable(),
    contributionMarginDeltaMicros: z.number().int().nullable(),
    evidence: z.array(z.string().trim().min(1)).min(1).readonly(),
  })
  .strict()
  .superRefine((marker, ctx) => {
    if (!marker.comparable && [marker.qceRateDelta, marker.sameCharacterD7Delta, marker.contributionMarginDeltaMicros]
      .some((value) => value !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["comparable"],
        message: "Non-comparable release changes cannot expose numeric deltas",
      });
    }
  });

export const characterPortfolioDecisionRecordSchema = z
  .object({
    id: adminIdSchema,
    characterId: adminIdSchema,
    releaseId: adminIdSchema,
    decision: characterPortfolioDecisionSchema,
    question: z.string().trim().min(1),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1).readonly(),
    evidenceLevel: z.enum(["observational", "attribution", "causal"]),
    confidence: z.number().min(0).max(1).nullable(),
    ownerId: adminIdSchema,
    successCriteria: z.array(z.string().trim().min(1)).min(1).readonly(),
    guardrails: z.array(z.string().trim().min(1)).readonly(),
    reviewAt: adminIsoDateTimeSchema.nullable(),
    outcome: z.record(z.string(), z.unknown()).nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const characterPortfolioDecisionRequestSchema = z
  .object({
    releaseId: adminIdSchema,
    decision: characterPortfolioDecisionSchema,
    question: z.string().trim().min(3).max(1_000),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1).max(100),
    evidenceLevel: z.enum(["observational", "attribution", "causal"]),
    confidence: z.number().min(0).max(1).nullable().default(null),
    successCriteria: z.array(z.string().trim().min(1)).min(1).max(50),
    guardrails: z.array(z.string().trim().min(1)).max(50).default([]),
    reviewAt: adminIsoDateTimeSchema.nullable().default(null),
  })
  .strict();

export const characterPortfolioVisualProductionSchema = z
  .object({
    primaryImageUrl: z.string().trim().min(1).nullable(),
    primaryImageSource: z.enum(["draft", "live"]).nullable(),
    draftPurposes: z
      .array(z.enum([
        "character_cover",
        "character_hero",
        "character_chat",
      ]))
      .max(3)
      .readonly(),
    livePurposes: z
      .array(z.enum([
        "character_cover",
        "character_hero",
        "character_chat",
      ]))
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
    if ((value.primaryImageUrl === null) !== (value.primaryImageSource === null)) {
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
  "continue_image_run",
  "continue_asset_pack",
  "run_preview_qa",
  "review_candidate_release",
  "monitor_live_character",
]);

const characterProductionPurposeSchema = z.enum([
  "character_cover",
  "character_hero",
  "character_chat",
]);

const characterProductionAssetPackProgressSchema = z
  .object({
    availablePurposes: z.array(characterProductionPurposeSchema).max(3).readonly(),
    missingPurposes: z.array(characterProductionPurposeSchema).max(3).readonly(),
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
        message: "Asset-pack progress must partition the three canonical purposes",
      });
    }
  });

export const characterProductionJourneySchema = z
  .object({
    projectionVersion: z.literal(1),
    asOf: adminIsoDateTimeSchema,
    stage: z.enum(["visual_setup", "image_production", "preview_qa", "release_review", "live_operations"]),
    status: z.enum(["blocked", "in_progress", "ready", "live"]),
    steps: z.tuple([
      z.object({ code: z.literal("visual_identity"), state: z.enum(["complete", "current", "upcoming", "blocked"]), deepLink: z.string().startsWith("/admin/characters/") }).strict(),
      z.object({ code: z.literal("image_assets"), state: z.enum(["complete", "current", "upcoming", "blocked"]), deepLink: z.string().startsWith("/admin/characters/") }).strict(),
      z.object({ code: z.literal("preview_qa"), state: z.enum(["complete", "current", "upcoming", "blocked"]), deepLink: z.string().startsWith("/admin/characters/") }).strict(),
      z.object({ code: z.literal("release"), state: z.enum(["complete", "current", "upcoming", "blocked"]), deepLink: z.string().startsWith("/admin/characters/") }).strict(),
      z.object({ code: z.literal("live_monitor"), state: z.enum(["complete", "current", "upcoming", "blocked"]), deepLink: z.string().startsWith("/admin/characters/") }).strict(),
    ]).readonly(),
    blockers: z.array(z.object({
      code: z.string().trim().min(1),
      message: z.string().trim().min(1),
      deepLink: z.string().startsWith("/admin/characters/"),
    }).strict()).readonly(),
    primaryAction: z.object({
      code: characterProductionActionCodeSchema,
      deepLink: z.string().startsWith("/admin/characters/"),
      command: z.object({
        id: adminIdSchema,
        type: z.string().trim().min(1),
        status: adminControlPlaneCommandStatusSchema,
        needsReconciliation: z.boolean(),
      }).strict().nullable(),
    }).strict(),
    assetPack: z.object({
      draft: characterProductionAssetPackProgressSchema,
      live: characterProductionAssetPackProgressSchema,
    }).strict(),
    release: z.object({
      servingState: characterServingStateSchema,
      currentReleaseId: adminIdSchema.nullable(),
      candidateReleaseId: adminIdSchema.nullable(),
    }).strict(),
  })
  .strict();

export const characterPortfolioItemSchema = z
  .object({
    characterId: adminIdSchema,
    name: z.string().trim().min(1),
    project: characterProjectSchema,
    serving: characterServingSchema,
    currentRelease: characterReleaseSchema.nullable(),
    candidateRelease: characterReleaseSchema.nullable(),
    readiness: adminReadinessSchema,
    verificationState: adminVerificationStateSchema.optional(),
    priority: adminPrioritySchema,
    performance: z.array(characterPerformanceSummarySchema).readonly(),
    changeMarkers: z.array(characterReleaseChangeMarkerSchema).readonly(),
    latestDecision: characterPortfolioDecisionRecordSchema.nullable(),
    visualProduction: characterPortfolioVisualProductionSchema,
    journey: characterProductionJourneySchema,
    operationalState: operationalStateViewSchema,
  })
  .strict();

export const characterPortfolioQuerySchema = adminCursorQuerySchema.extend({
  phase: characterProjectPhaseSchema.optional(),
  servingState: characterServingStateSchema.optional(),
  readiness: adminReadinessSchema.optional(),
  ownerId: adminIdSchema.optional(),
  decision: characterPortfolioDecisionSchema.optional(),
  placementId: adminIdSchema.optional(),
  // SPEC: attention 只收「已上线但整个观察窗口零观测」。故意不含资产包不完整（Journey
  // 已经在说）和"无负责人"（对几乎每个角色都为真）——多收一条就把这个筛子稀释成恒真告警。
  // INTENT: 做成筛选而不是排序 —— 列表是 keyset 分页，排序只在页内生效，第三页的问题角色照样发现不了。
  // 不用 z.coerce.boolean()：它把 "false" 也当真，一个筛不掉的筛子比没有更糟。
  attention: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .optional(),
  sort: z.enum(["project_id_asc"]).default("project_id_asc"),
});

export const characterPortfolioResponseSchema = adminListResponseSchema(characterPortfolioItemSchema);

export const characterPerformanceBackfillRequestSchema = z
  .object({
    source: z.string().trim().min(1).max(120),
    kind: z.enum(["funnel", "variable_cost"]),
    dryRun: z.boolean().default(true),
    batchSize: z.number().int().min(1).max(1_000).default(200),
    cursor: z.string().trim().min(1).nullable().default(null),
  })
  .strict();

export const characterPerformanceBackfillResponseSchema = z.object({
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
}).strict();

export const characterPerformanceReconciliationSchema = z.object({
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
}).strict();

export type CharacterPortfolioItem = z.infer<typeof characterPortfolioItemSchema>;

export type CharacterProductionJourney = z.infer<typeof characterProductionJourneySchema>;

export type CharacterPortfolioQuery = z.infer<typeof characterPortfolioQuerySchema>;

export type CharacterPerformanceSummary = z.infer<typeof characterPerformanceSummarySchema>;

export type CharacterPerformanceWindow = z.infer<typeof characterPerformanceWindowSchema>;

export type CharacterContributionMargin = z.infer<typeof characterContributionMarginSchema>;

export type CharacterPortfolioDecision = z.infer<typeof characterPortfolioDecisionSchema>;

export type CharacterPortfolioDecisionRequest = z.infer<typeof characterPortfolioDecisionRequestSchema>;

export type CharacterPortfolioDecisionRecord = z.infer<typeof characterPortfolioDecisionRecordSchema>;

export type CharacterPerformanceBackfillRequest = z.infer<typeof characterPerformanceBackfillRequestSchema>;

export type CharacterPerformanceReconciliation = z.infer<typeof characterPerformanceReconciliationSchema>;
