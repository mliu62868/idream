import { z } from "zod";
import {
  adminDataClassSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminJsonValueSchema,
  adminPageInfoSchema,
} from "./common";

export const accessUserRoleSchema = z.enum([
  "user",
  "moderator",
  "support",
  "ops",
  "analyst",
  "admin",
]);

export const accessUserStatusSchema = z.enum([
  "active",
  "suspended",
  "deleted",
]);

export const accessUserListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    role: accessUserRoleSchema.optional(),
    status: accessUserStatusSchema.optional(),
    dataClass: adminDataClassSchema.optional(),
    cursor: z.string().min(1).optional(),
    before: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const accessUserListItemSchema = z
  .object({
    id: adminIdSchema,
    email: z.string().trim().min(1),
    displayName: z.string().nullable(),
    role: accessUserRoleSchema,
    status: accessUserStatusSchema,
    dataClass: adminDataClassSchema,
    createdAt: adminIsoDateTimeSchema,
    plan: z
      .object({
        slug: z.string().trim().min(1),
        billingPeriod: z.string().trim().min(1),
        status: z.string().trim().min(1),
      })
      .strict()
      .nullable(),
    dreamcoins: z.number().int(),
  })
  .strict();

export const accessUserListResponseSchema = z
  .object({
    items: z.array(accessUserListItemSchema).readonly(),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

/**
 * SPEC: 每条用户权威写命令都带 reason + confirmation。
 * INTENT: confirmation 的期望值由目标本身决定（`${userId}:${status}` 等），所以契约只能约束
 *         长度，真正的比对留在 authority 模块 —— 那里才知道目标是谁。
 */
const accessCommandReasonSchema = z.string().trim().min(3).max(2_000);
const accessCommandConfirmationSchema = z.string().trim().min(1).max(160);

export const accessUserStatusCommandSchema = z
  .object({
    status: z.enum(["active", "suspended"]),
    reason: accessCommandReasonSchema,
    confirmation: accessCommandConfirmationSchema,
  })
  .strict();

export const accessUserRoleCommandSchema = z
  .object({
    role: accessUserRoleSchema,
    reason: accessCommandReasonSchema,
    confirmation: accessCommandConfirmationSchema,
  })
  .strict();

export const accessUserPermissionCommandSchema = z
  .object({
    permissionKey: z.string().trim().min(1).max(80),
    effect: z.enum(["grant", "revoke", "clear"]),
    reason: accessCommandReasonSchema,
    confirmation: accessCommandConfirmationSchema,
  })
  .strict();

export const accessUserSummarySchema = z
  .object({
    id: adminIdSchema,
    email: z.string().trim().min(1),
    displayName: z.string().nullable(),
    role: accessUserRoleSchema,
    status: accessUserStatusSchema,
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const accessUserCommandResultSchema = z
  .object({
    user: accessUserSummarySchema,
    replayed: z.boolean(),
  })
  .strict();

export const accessPermissionOverrideSchema = z
  .object({
    id: adminIdSchema,
    userId: adminIdSchema,
    permissionKey: z.string().trim().min(1),
    effect: z.enum(["grant", "revoke"]),
    reason: z.string(),
    createdById: adminIdSchema,
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const accessUserPermissionListSchema = z
  .object({
    role: accessUserRoleSchema,
    overrides: z.array(accessPermissionOverrideSchema).readonly(),
    effective: z.array(z.string().trim().min(1)).readonly(),
  })
  .strict();

export const accessUserPermissionResultSchema = z
  .object({
    override: accessPermissionOverrideSchema.nullable(),
    cleared: z.boolean(),
    replayed: z.boolean(),
  })
  .strict();

const accessUserPreferencesSchema = z
  .object({
    userId: adminIdSchema,
    mutedTags: adminJsonValueSchema,
    safeModeFlags: adminJsonValueSchema,
    notificationSettings: adminJsonValueSchema,
    locale: z.string().trim().min(1),
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

const accessAgeVerificationSchema = z
  .object({
    id: adminIdSchema,
    provider: z.string().trim().min(1),
    status: z.string().trim().min(1),
    jurisdiction: z.string().nullable(),
    requiredReason: z.string().nullable(),
    verifiedAt: adminIsoDateTimeSchema.nullable(),
    expiresAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

const accessSubscriptionSchema = z
  .object({
    id: adminIdSchema,
    provider: z.string().trim().min(1),
    status: z.string().trim().min(1),
    planSlug: z.string().trim().min(1),
    planName: z.string().trim().min(1),
    billingPeriod: z.string().trim().min(1),
    currentPeriodEnd: adminIsoDateTimeSchema.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

const accessEntitlementSchema = z
  .object({
    id: adminIdSchema,
    key: z.string().trim().min(1),
    value: adminJsonValueSchema,
    source: z.string().trim().min(1),
    expiresAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

const accessLedgerEntrySchema = z
  .object({
    id: adminIdSchema,
    delta: z.number().int(),
    balanceAfter: z.number().int(),
    reason: z.string().trim().min(1),
    sourceId: z.string().nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

/**
 * SPEC: 用户详情里的生成任务只暴露运营判断需要的字段，prompt 只报「有没有」。
 * INTENT: v1 在这里直接回传 `redactGenerationJob` 的全量投影（含 assets 的 blob URL）。
 *         访问权威页判断的是「这个人在生成什么、失败在哪」，不是看图，所以资产列表不进契约。
 */
const accessGenerationJobSchema = z
  .object({
    id: adminIdSchema,
    mode: z.string().trim().min(1),
    model: z.string().nullable(),
    status: z.string().trim().min(1),
    provider: z.string().nullable(),
    errorCode: z.string().nullable(),
    outputCount: z.number().int().nonnegative(),
    costDreamcoins: z.number().int(),
    promptHidden: z.boolean(),
    negativePromptHidden: z.boolean(),
    createdAt: adminIsoDateTimeSchema,
    completedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const accessUserDetailSchema = z
  .object({
    user: z
      .object({
        id: adminIdSchema,
        email: z.string().trim().min(1),
        displayName: z.string().nullable(),
        role: accessUserRoleSchema,
        status: accessUserStatusSchema,
        dataClass: adminDataClassSchema,
        createdAt: adminIsoDateTimeSchema,
        ageVerification: accessAgeVerificationSchema.nullable(),
        preferences: accessUserPreferencesSchema.nullable(),
      })
      .strict(),
    subscriptions: z.array(accessSubscriptionSchema).readonly(),
    entitlements: z.array(accessEntitlementSchema).readonly(),
    ledger: z.array(accessLedgerEntrySchema).readonly(),
    dreamcoins: z.object({ balance: z.number().int() }).strict(),
    generationJobs: z.array(accessGenerationJobSchema).readonly(),
  })
  .strict();

export type AccessUserListItem = z.infer<typeof accessUserListItemSchema>;
export type AccessUserListQuery = z.infer<typeof accessUserListQuerySchema>;
export type AccessUserListResponse = z.infer<typeof accessUserListResponseSchema>;
export type AccessUserDetail = z.infer<typeof accessUserDetailSchema>;
export type AccessPermissionOverride = z.infer<typeof accessPermissionOverrideSchema>;
