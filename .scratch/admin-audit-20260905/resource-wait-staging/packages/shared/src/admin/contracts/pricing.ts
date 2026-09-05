import { z } from "zod";
import { adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

export const adminPricingRuleQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    mode: z.string().trim().min(1).max(80).optional(),
    status: z.enum(["draft", "active", "archived"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const adminPricingRuleSchema = z
  .object({
    id: z.string().min(1),
    ruleKey: z.string().min(1),
    label: z.string().min(1),
    mode: z.string().min(1),
    baseCost: z.number().int().nonnegative(),
    multiplier: z.number(),
    status: z.enum(["draft", "active", "archived"]),
    version: z.number().int().positive(),
    effectiveFrom: adminIsoDateTimeSchema.nullable(),
    publishedAt: adminIsoDateTimeSchema.nullable(),
    archivedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const adminPricingRuleListResponseSchema = z
  .object({
    items: z.array(adminPricingRuleSchema),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export const adminPricingRuleCreateRequestSchema = z.object({
  ruleKey: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  mode: z.enum(["image", "video", "voice"]).default("image"),
  baseCost: z.number().int().min(0).max(100_000),
  multiplier: z.number().min(0.1).max(20).default(1),
  effectiveFrom: z.string().datetime().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export const adminPricingRulePatchRequestSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  baseCost: z.number().int().min(0).max(100_000).optional(),
  multiplier: z.number().min(0.1).max(20).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
});

export const adminPricingRulePublishRequestSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
  effectiveFrom: z.string().datetime().optional(),
});

export const adminPricingRuleRollbackRequestSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export const adminPricingRuleMutationResponseSchema = z
  .object({ rule: adminPricingRuleSchema })
  .strict();

export const adminPricingRulePublishResponseSchema = z
  .object({
    rule: adminPricingRuleSchema,
    previousActiveId: z.string().min(1).nullable(),
  })
  .strict();

export const adminPricingRuleRollbackResponseSchema = z
  .object({
    rule: adminPricingRuleSchema,
    fromVersion: z.number().int().positive(),
    toVersion: z.number().int().positive(),
  })
  .strict();

export type AdminPricingRuleCreateRequest = z.infer<
  typeof adminPricingRuleCreateRequestSchema
>;
export type AdminPricingRulePatchRequest = z.infer<
  typeof adminPricingRulePatchRequestSchema
>;
export type AdminPricingRulePublishRequest = z.infer<
  typeof adminPricingRulePublishRequestSchema
>;
export type AdminPricingRuleRollbackRequest = z.infer<
  typeof adminPricingRuleRollbackRequestSchema
>;
export type AdminPricingRule = z.infer<typeof adminPricingRuleSchema>;
export type AdminPricingRuleListResponse = z.infer<
  typeof adminPricingRuleListResponseSchema
>;
