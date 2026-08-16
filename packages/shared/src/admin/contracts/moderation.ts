import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

/**
 * SPEC: 审核队列与三类审核裁决（举报 / 独立复核的角色图 / 申诉）的公开契约。
 * INTENT: v1 直接把 Prisma 行（含 reporter 的 User 关系、MediaAsset 的 prompt/metadata）
 *         整行发出去，没有任何机器可验证的边界。这里只声明运营台真正消费的投影 ——
 *         `.strict()` 让多发一个字段变成运行时违约，而不是悄悄多泄一列。
 */

export const moderationQueueScopeSchema = z.enum(["reports", "media", "appeals"]);

export const moderationQueueQuerySchema = z
  .object({
    scope: moderationQueueScopeSchema.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    id: adminIdSchema.optional(),
    targetType: z.string().trim().min(1).max(120).optional(),
    targetId: adminIdSchema.optional(),
    // 逗号分隔的举报状态；`all` 表示放弃默认的 open/triaged/reviewing 过滤。
    status: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    reportCursor: z.string().trim().min(1).optional(),
    mediaCursor: z.string().trim().min(1).optional(),
    appealCursor: z.string().trim().min(1).optional(),
  })
  .strict();

export const moderationReportSchema = z
  .object({
    id: adminIdSchema,
    reporterId: adminIdSchema.nullable(),
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    category: z.string().min(1),
    description: z.string().nullable(),
    status: z.string().min(1),
    priority: z.number().int(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const moderationMediaReviewItemSchema = z
  .object({
    id: adminIdSchema,
    ownerId: adminIdSchema,
    characterId: adminIdSchema.nullable(),
    type: z.string().min(1),
    url: z.string().min(1),
    thumbnailUrl: z.string().nullable(),
    safetyStatus: z.string().min(1),
    reviewKind: z.enum(["independent_duplicate", "blocked"]),
    sourceAssetId: adminIdSchema.nullable(),
    sourceCharacterId: adminIdSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const moderationAppealSchema = z
  .object({
    id: adminIdSchema,
    userId: adminIdSchema,
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    originalDecisionId: adminIdSchema.nullable(),
    status: z.string().min(1),
    appealText: z.string(),
    reviewerId: adminIdSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
    resolvedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const moderationQueueResponseSchema = z
  .object({
    reports: z.array(moderationReportSchema),
    mediaReview: z.array(moderationMediaReviewItemSchema),
    appeals: z.array(moderationAppealSchema),
    pageInfo: z
      .object({
        reports: adminPageInfoSchema,
        mediaReview: adminPageInfoSchema,
        appeals: adminPageInfoSchema,
      })
      .strict(),
  })
  .strict();

export const moderationReviewSchema = z
  .object({
    id: adminIdSchema,
    reportId: adminIdSchema.nullable(),
    reviewerId: adminIdSchema,
    decision: z.string().min(1),
    policyCode: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const moderationReportDecisionRequestSchema = z
  .object({
    decision: z.enum(["actioned", "no_violation", "duplicate", "escalated", "closed"]),
    policyCode: z.string().max(120).optional(),
    notes: z.string().max(2_000).optional(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const moderationReportDecisionResponseSchema = z
  .object({
    review: moderationReviewSchema,
    report: moderationReportSchema,
    replayed: z.boolean(),
  })
  .strict();

export const moderationMediaDecisionRequestSchema = z
  .object({
    decision: z.enum(["passed", "blocked"]),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const moderationMediaAssetSchema = z
  .object({
    id: adminIdSchema,
    ownerId: adminIdSchema,
    characterId: adminIdSchema.nullable(),
    safetyStatus: z.string().min(1),
    visibility: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const moderationMediaDecisionResponseSchema = z
  .object({
    asset: moderationMediaAssetSchema,
    review: moderationReviewSchema,
    replayed: z.boolean(),
  })
  .strict();

export const moderationAppealDecisionRequestSchema = z
  .object({
    outcome: z.enum(["upheld", "overturned", "modified", "open"]),
    notes: z.string().trim().max(2_000).optional(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

// INVARIANT: 只有 overturned 会去恢复目标，所以恢复目标的三个字段是条件性的；
// 未恢复时 `restoreReason` 说明为什么（不可解析的 feed_item / 需要人工跟进）。
export const moderationAppealTargetRestorationSchema = z
  .object({
    targetRestored: z.boolean(),
    restoredTargetType: z.string().min(1).optional(),
    restoredTargetId: adminIdSchema.optional(),
    restoreReason: z.string().min(1).optional(),
  })
  .strict();

export const moderationAppealDecisionResponseSchema = z
  .object({
    appeal: moderationAppealSchema,
    target: moderationAppealTargetRestorationSchema,
    replayed: z.boolean(),
  })
  .strict();

export type ModerationQueueQuery = z.infer<typeof moderationQueueQuerySchema>;
export type ModerationQueueResponse = z.infer<typeof moderationQueueResponseSchema>;
