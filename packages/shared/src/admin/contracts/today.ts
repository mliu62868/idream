import { z } from "zod";
import {
  adminDataClassSchema,
  adminEnvironmentSchema,
  adminFreshnessSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminPrioritySchema,
  adminSeveritySchema,
  adminVerificationStateSchema,
} from "./common";

export const todaySourceTypeSchema = z.enum([
  "admin_case",
  "ops_incident",
  "control_plane_command",
  "collaboration_mention",
  "character_release",
  "creative_run",
]);

export const todayWorkModeSchema = z.enum([
  "character_producer",
  "creative_operator",
  "platform_ops",
  "support",
  "moderator",
  "growth_analyst",
  "admin",
]);

export const todayProjectionQuerySchema = z.object({
  workMode: todayWorkModeSchema.optional(),
}).strict();

export const todayWorkItemSchema = z
  .object({
    sourceType: todaySourceTypeSchema,
    sourceId: adminIdSchema,
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    severity: adminSeveritySchema,
    priority: adminPrioritySchema,
    impactSnapshot: z.record(z.string(), z.unknown()),
    ownerId: adminIdSchema.nullable(),
    slaDueAt: adminIsoDateTimeSchema.nullable(),
    recommendedAction: z.string().trim().min(1),
    rankingReason: z.string().trim().min(1),
    deepLink: z.string().startsWith("/admin/"),
    verificationState: adminVerificationStateSchema,
    lastChangedAt: adminIsoDateTimeSchema,
    environment: adminEnvironmentSchema,
    dataClass: adminDataClassSchema,
    pinned: z.boolean(),
    preferenceVersion: z.number().int().nonnegative(),
    claim: z
      .object({
        entityVersion: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const todayQueueSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    items: z.array(todayWorkItemSchema).max(10).readonly(),
  })
  .strict();

export const todayProjectionSchema = z
  .object({
    myShift: todayQueueSchema,
    nextBestActions: todayQueueSchema,
    unassigned: todayQueueSchema,
    watching: todayQueueSchema,
    recentlyResolved: todayQueueSchema,
    asOf: adminIsoDateTimeSchema,
    freshness: adminFreshnessSchema,
    workMode: todayWorkModeSchema,
    rankingPolicyVersion: z.string().trim().min(1),
  })
  .strict();

export const operationalWorkPreferenceUpdateSchema = z
  .object({
    sourceType: todaySourceTypeSchema,
    sourceId: adminIdSchema,
    watching: z.boolean().optional(),
    pinned: z.boolean().optional(),
    snoozedUntil: adminIsoDateTimeSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.watching !== undefined || value.pinned !== undefined || value.snoozedUntil !== undefined, {
    message: "At least one preference field is required",
  });

export const operationalWorkPreferenceSchema = z
  .object({
    sourceType: todaySourceTypeSchema,
    sourceId: adminIdSchema,
    watching: z.boolean(),
    pinned: z.boolean(),
    snoozedUntil: adminIsoDateTimeSchema.nullable(),
    version: z.number().int().positive(),
  })
  .strict();

export const todayClaimRequestSchema = z
  .object({
    sourceType: z.enum(["admin_case", "ops_incident", "character_release", "creative_run"]),
    sourceId: adminIdSchema,
    entityVersion: z.number().int().nonnegative(),
  })
  .strict();

export const todayClaimResponseSchema = z
  .object({
    sourceType: z.enum(["admin_case", "ops_incident", "character_release", "creative_run"]),
    sourceId: adminIdSchema,
    ownerId: adminIdSchema,
    entityVersion: z.number().int().nonnegative(),
  })
  .strict();

export type TodaySourceType = z.infer<typeof todaySourceTypeSchema>;
export type TodayWorkMode = z.infer<typeof todayWorkModeSchema>;
export type TodayWorkItem = z.infer<typeof todayWorkItemSchema>;
export type TodayQueue = z.infer<typeof todayQueueSchema>;
export type TodayProjection = z.infer<typeof todayProjectionSchema>;
export type TodayClaimRequest = z.infer<typeof todayClaimRequestSchema>;
export type TodayClaimResponse = z.infer<typeof todayClaimResponseSchema>;
export type OperationalWorkPreference = z.infer<typeof operationalWorkPreferenceSchema>;
