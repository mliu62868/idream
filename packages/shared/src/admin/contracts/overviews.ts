import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

/**
 * SPEC: 后台运营大盘（dashboard / analytics overview / analytics export / retention /
 *   flag monitoring）的公开响应契约。
 * INTENT: 这五个端点在 v1 里没有任何机器可验证的出参声明，只有一串 `ok({...})`。
 *   它们共享同一套「窗口 + 数据口径 + 质量标注」结构，所以先把这三件公共物抽出来，
 *   剩下的每个面板只声明自己那一块。
 * INTENT: risk/abuse 与 ops/providers 同住 v1 的 overviews/service.ts，但分属另外两路，
 *   它们的契约不在这里。
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

export const adminOverviewWindowSchema = z
  .object({
    from: adminIsoDateTimeSchema,
    to: adminIsoDateTimeSchema,
  })
  .strict();

const ADMIN_OVERVIEW_MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;
// INTENT: a valid ISO instant can still be year 0000, which Postgres refuses. No overview has data
// before the epoch, so it is rejected as input rather than reaching the driver.
// Date-only is a supported caller form; z.string().date() still refuses a day that doesn't exist.
const adminOverviewInstantSchema = z.union([adminIsoDateTimeSchema, z.string().date()]).refine(
  (value) => Date.parse(value) >= 0,
  "Window date is out of range",
);

/**
 * Shared by the three window-scoped overviews; the manifest binds it per operation.
 * INVARIANT: strict ISO instants or calendar dates only. `Date.parse` accepted `foo 1` as 2001 and rolled
 * `2026-02-31` over into March, so a typo became a confident answer about the wrong period.
 */
export const adminOverviewWindowQuerySchema = z
  .object({
    from: adminOverviewInstantSchema.optional(),
    to: adminOverviewInstantSchema.optional(),
  })
  .strict()
  // Defaults belong to the authority; explicit endpoints already define an inclusive window.
  .refine(({ from, to }) => !from || !to || Date.parse(from) <= Date.parse(to), {
    message: "The start of the window must not be after the end.",
    path: ["from"],
  })
  // An open-ended `from` runs to now on the authority, so it counts against the same bound.
  .refine(({ from, to }) => !from || (to ? Date.parse(to) : Date.now()) - Date.parse(from) <= ADMIN_OVERVIEW_MAX_WINDOW_MS, {
    message: "The window must not be longer than 365 days.",
    path: ["from"],
  });

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
    // SPEC: featureFlags 是一份**截断**的预览列表，featureFlagCount 才是总数。
    // INTENT: Today 的 "Feature flags" tile 过去读 featureFlags.length，而该列表
    //   在服务端就 take: 8 —— 旗标超过 8 条后这个数字会永远停在 8。计数必须有
    //   独立来源，不能从一份带上限的列表推出来。
    featureFlags: z.array(adminFeatureFlagSummarySchema).readonly(),
    featureFlagCount: nonNegativeInt,
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
export type ExperimentFlagMonitoringResponse = z.infer<
  typeof experimentFlagMonitoringResponseSchema
>;
