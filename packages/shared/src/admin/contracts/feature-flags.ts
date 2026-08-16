import { z } from "zod";
import { adminIsoDateTimeSchema, adminJsonValueSchema, adminPageInfoSchema } from "./common";

/**
 * SPEC: `limit` 缺省时返回全量、不分页。
 * INTENT: 开关总数是几十条量级，运营台的「设置」页要一次看全；给它一个默认页长反而会
 *         让没翻页控件的调用方静默丢开关。
 */
export const featureFlagListQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    enabled: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).optional(),
  })
  .strict();

export const featureFlagSchema = z
  .object({
    key: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().nullable(),
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    targetRoles: adminJsonValueSchema,
    targetPlans: adminJsonValueSchema,
    hardPolicy: z.boolean(),
    version: z.number().int().positive(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const featureFlagListResponseSchema = z
  .object({
    items: z.array(featureFlagSchema).readonly(),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export const featureFlagPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    targetRoles: z.array(z.string()).optional(),
    targetPlans: z.array(z.string()).optional(),
    description: z.string().max(500).optional(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const featureFlagMutationResponseSchema = z
  .object({
    flag: featureFlagSchema,
    replayed: z.boolean(),
  })
  .strict();

export type FeatureFlag = z.infer<typeof featureFlagSchema>;
export type FeatureFlagListQuery = z.infer<typeof featureFlagListQuerySchema>;
export type FeatureFlagListResponse = z.infer<typeof featureFlagListResponseSchema>;
