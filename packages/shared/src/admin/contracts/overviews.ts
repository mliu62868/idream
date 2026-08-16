import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

/**
 * SPEC: 后台运营大盘（dashboard / analytics overview / risk abuse / provider ops /
 *   analytics export / retention / flag monitoring）的公开响应契约。
 * INTENT: 这七个端点在 v1 里没有任何机器可验证的出参声明，只有一串 `ok({...})`。
 *   它们共享同一套「窗口 + 数据口径 + 质量标注」结构，所以先把这三件公共物抽出来，
 *   剩下的每个面板只声明自己那一块。
 * INVARIANT: `qualityState: "invalid"` / `validForDecisions: false` 是 legacy 口径的
 *   既定事实（activation/conversion/retention 至今没有认证的 cohort 口径），因此写成
 *   literal 而不是枚举 —— 哪天真的认证了，改的是声明本身，不会被悄悄放行。
 */

const nonNegativeInt = z.number().int().nonnegative();

export const adminCustomerMetricDataScopeSchema = z
  .object({
    kind: z.literal("customer"),
    includedDataClasses: z.array(z.string().min(1)).readonly(),
    excludedDataClasses: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export const adminOperationalMetricDataScopeSchema = z
  .object({
    kind: z.literal("operational"),
    includedDataClasses: z.array(z.string().min(1)).readonly(),
    excludedDataClasses: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export const adminOverviewWindowSchema = z
  .object({
    from: adminIsoDateTimeSchema,
    to: adminIsoDateTimeSchema,
  })
  .strict();

/** Shared by the three window-scoped overviews; the manifest binds it per operation. */
export const adminOverviewWindowQuerySchema = z
  .object({
    from: z.string().trim().min(1).optional(),
    to: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminFeatureFlagSummarySchema = z
  .object({
    key: z.string().min(1),
    label: z.string(),
    enabled: z.boolean(),
    rolloutPercent: z.number().int(),
    hardPolicy: z.boolean(),
  })
  .strict();

// ---- dashboard ----

export const adminDashboardResponseSchema = z
  .object({
    dataScope: adminCustomerMetricDataScopeSchema,
    metrics: z
      .object({
        users: z
          .object({ active: nonNegativeInt, suspended: nonNegativeInt })
          .strict(),
        generation: z
          .object({
            queued: nonNegativeInt,
            failed: nonNegativeInt,
            blocked: nonNegativeInt,
            successRate: z.number().int().min(0).max(100).nullable(),
          })
          .strict(),
        moderation: z.object({ openReports: nonNegativeInt }).strict(),
        billing: z.object({ activeSubscriptions: nonNegativeInt }).strict(),
      })
      .strict(),
    featureFlags: z.array(adminFeatureFlagSummarySchema).readonly(),
  })
  .strict();

// ---- analytics overview ----

export const analyticsOverviewResponseSchema = z
  .object({
    dataScope: adminCustomerMetricDataScopeSchema,
    window: adminOverviewWindowSchema,
    funnel: z
      .object({
        signups: nonNegativeInt,
        activatedUsers: z.null(),
        payingUsers: z.null(),
        conversionRate: z.null(),
        qualityState: z.literal("invalid"),
        validForDecisions: z.literal(false),
        metricVersion: z.literal("legacy-v1"),
        reason: z.string().min(1),
        legacyObserved: z
          .object({
            activatedUsers: nonNegativeInt,
            payingUsers: nonNegativeInt,
            conversionRate: z.number(),
          })
          .strict(),
      })
      .strict(),
    generation: z
      .object({
        total: nonNegativeInt,
        completed: nonNegativeInt,
        failed: nonNegativeInt,
        blocked: nonNegativeInt,
        qualityState: z.literal("directional"),
        validForDecisions: z.literal(false),
        reason: z.string().min(1),
      })
      .strict(),
    economy: z
      .object({
        coinsGranted: z.number(),
        coinsSpent: z.number(),
        net: z.number(),
        byReason: z
          .array(
            z
              .object({
                reason: z.string().min(1),
                totalDelta: z.number(),
                count: nonNegativeInt,
              })
              .strict(),
          )
          .readonly(),
      })
      .strict(),
    topEvents: z
      .array(z.object({ name: z.string().min(1), count: nonNegativeInt }).strict())
      .readonly(),
  })
  .strict();

// ---- risk / abuse overview ----

export const abuseOverviewResponseSchema = z
  .object({
    dataScope: adminCustomerMetricDataScopeSchema,
    window: adminOverviewWindowSchema,
    deviceClusters: z
      .array(
        z
          .object({
            anonymousId: adminIdSchema,
            accountCount: nonNegativeInt,
            userIds: z.array(adminIdSchema).readonly(),
          })
          .strict(),
      )
      .readonly(),
    referralAbuse: z
      .array(
        z
          .object({ inviterId: adminIdSchema, referralCount: nonNegativeInt })
          .strict(),
      )
      .readonly(),
    adjustAnomalies: z
      .array(
        z
          .object({
            userId: adminIdSchema,
            totalDelta: z.number(),
            count: nonNegativeInt,
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

// ---- provider ops overview ----

export const providerOpsResponseSchema = z
  .object({
    dataScope: adminOperationalMetricDataScopeSchema,
    window: adminOverviewWindowSchema,
    providers: z
      .array(
        z
          .object({
            provider: z.string().min(1),
            total: nonNegativeInt,
            completed: nonNegativeInt,
            failed: nonNegativeInt,
            blocked: nonNegativeInt,
            coinsCost: z.number(),
            successRate: z.number().int().min(0).max(100).nullable(),
            avgCostPerJob: z.number(),
            latencyP50Ms: z.number().nullable(),
            latencyP95Ms: z.number().nullable(),
            latencySamples: nonNegativeInt,
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

// ---- analytics export + retention ----

export const analyticsExportQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
  .strict();

export const analyticsExportResponseSchema = z
  .object({
    dataScope: adminCustomerMetricDataScopeSchema,
    window: z
      .object({ from: adminIsoDateTimeSchema, days: z.number().int().min(1).max(365) })
      .strict(),
    qualityState: z.literal("invalid"),
    validForDecisions: z.literal(false),
    csv: z.string(),
  })
  .strict();

export const analyticsRetentionQuerySchema = z
  .object({ weeks: z.coerce.number().int().min(1).max(12).default(4) })
  .strict();

export const analyticsRetentionResponseSchema = z
  .object({
    dataScope: adminCustomerMetricDataScopeSchema,
    window: z
      .object({ from: adminIsoDateTimeSchema, weeks: z.number().int().min(1).max(12) })
      .strict(),
    qualityState: z.literal("invalid"),
    validForDecisions: z.literal(false),
    metricVersion: z.literal("legacy-v1"),
    reason: z.string().min(1),
    items: z.array(z.unknown()).readonly(),
  })
  .strict();

// ---- feature-flag monitoring (v1 `experiments`) ----

export const experimentFlagMonitoringResponseSchema = z
  .object({
    dataScope: adminCustomerMetricDataScopeSchema,
    items: z
      .array(
        adminFeatureFlagSummarySchema
          .extend({
            createdAt: adminIsoDateTimeSchema,
            metrics: z
              .object({
                signups: nonNegativeInt,
                activatedUsers: nonNegativeInt,
                payingUsers: nonNegativeInt,
              })
              .strict(),
          })
          .strict(),
      )
      .readonly(),
    note: z.string().min(1),
  })
  .strict();

export type AdminDashboardResponse = z.infer<typeof adminDashboardResponseSchema>;
export type AnalyticsOverviewResponse = z.infer<typeof analyticsOverviewResponseSchema>;
export type AbuseOverviewResponse = z.infer<typeof abuseOverviewResponseSchema>;
export type ProviderOpsResponse = z.infer<typeof providerOpsResponseSchema>;
export type ExperimentFlagMonitoringResponse = z.infer<
  typeof experimentFlagMonitoringResponseSchema
>;
