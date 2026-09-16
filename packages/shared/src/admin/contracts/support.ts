import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";
import { supportMessageBodySchema } from "../../contracts/support";
import { PRODUCT_FEEDBACK_CATEGORIES, PRODUCT_FEEDBACK_STATUSES } from "../../catalog";
export { supportConversationResponseSchema } from "../../contracts/support";

export const productFeedbackListQuerySchema = z.object({
  status: z.enum(["all", ...PRODUCT_FEEDBACK_STATUSES]).default("all"),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const productFeedbackSchema = z.object({
  id: adminIdSchema,
  title: z.string(),
  description: z.string(),
  category: z.enum(PRODUCT_FEEDBACK_CATEGORIES),
  status: z.enum(PRODUCT_FEEDBACK_STATUSES),
  voteCount: z.number().int().nonnegative(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const productFeedbackListResponseSchema = z.object({
  items: z.array(productFeedbackSchema),
  pageInfo: adminPageInfoSchema,
}).strict();

export const productFeedbackUpdateSchema = z.object({
  status: z.enum(PRODUCT_FEEDBACK_STATUSES),
  expectedUpdatedAt: adminIsoDateTimeSchema,
  reason: z.string().trim().min(3).max(2_000),
}).strict();

export const productFeedbackMutationResponseSchema = z.object({
  item: productFeedbackSchema,
  replayed: z.boolean(),
}).strict();

export type ProductFeedback = z.infer<typeof productFeedbackSchema>;

export const supportRequestStatusSchema = z.enum([
  "received",
  "open",
  "waiting_on_user",
  "resolved",
  "closed",
]);

export const supportSlaStateSchema = z.enum([
  "overdue",
  "due_soon",
  "on_track",
  "paused",
  "closed",
]);

/**
 * SPEC: `status` 是逗号分隔的多选，外加两个聚合值 `all` / `active`。
 * INTENT: 不做成 array —— 查询串里它就是一个字符串，拆分规则属于 authority 模块的读逻辑，
 *         塞进契约只会让 URL 形态和契约形态各写一遍。
 */
export const supportRequestListQuerySchema = z
  .object({
    ticketId: z.string().trim().min(1).max(160).optional(),
    userId: z.string().trim().min(1).max(160).optional(),
    assignedToId: z.string().trim().min(1).max(160).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    status: z.string().trim().min(1).max(200).optional(),
    sla: z.enum(["all", "overdue", "due_soon", "on_track", "paused", "closed"]).default("all"),
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const supportRequestSchema = z
  .object({
    id: adminIdSchema,
    ticketId: adminIdSchema,
    userId: adminIdSchema,
    userEmail: z.string().trim().min(1),
    userName: z.string().trim().min(1),
    category: z.string().trim().min(1),
    subject: z.string(),
    description: z.string(),
    diagnosticConsent: z.boolean(),
    sourcePath: z.string().nullable(),
    status: supportRequestStatusSchema,
    priority: z.number().int().min(1).max(5),
    assignedToId: z.string().nullable(),
    assignedToEmail: z.string().nullable(),
    assignedToName: z.string().nullable(),
    slaEscalatedAt: adminIsoDateTimeSchema.nullable(),
    slaEscalatedById: z.string().nullable(),
    slaEscalationReason: z.string().nullable(),
    resolutionNotes: z.string().nullable(),
    resolvedAt: adminIsoDateTimeSchema.nullable(),
    slaDueAt: adminIsoDateTimeSchema.nullable(),
    slaHoursRemaining: z.number().int().nullable(),
    slaState: supportSlaStateSchema,
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const supportRequestListResponseSchema = z
  .object({
    items: z.array(supportRequestSchema).readonly(),
    pageInfo: adminPageInfoSchema,
    asOf: adminIsoDateTimeSchema,
    freshness: z.literal("fresh"),
  })
  .strict();

export const supportRequestPatchSchema = z
  .object({
    status: supportRequestStatusSchema.optional(),
    assignedToId: z.string().trim().min(1).max(160).nullable().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    resolutionNotes: z.string().trim().max(2_000).nullable().optional(),
    customerMessage: supportMessageBodySchema.optional(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const supportRequestEscalateSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const supportRequestMutationResponseSchema = z
  .object({
    request: supportRequestSchema,
    replayed: z.boolean(),
  })
  .strict();

const supportPlaintextTargetTypeSchema = z.enum(["generation_job", "media"]);

export const supportPlaintextViewRequestSchema = z
  .object({
    targetType: supportPlaintextTargetTypeSchema,
    targetId: z.string().trim().min(1).max(160),
    ticketId: z.string().trim().min(1).max(160).optional(),
    legalHoldId: z.string().trim().min(1).max(160).optional(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const supportPlaintextViewResponseSchema = z
  .object({
    target: z
      .object({
        type: supportPlaintextTargetTypeSchema,
        id: adminIdSchema,
        ownerId: adminIdSchema,
      })
      .strict(),
    plaintext: z.record(z.string(), z.string().nullable()),
    authorization: z
      .object({
        ticketId: z.string().nullable(),
        legalHoldId: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * SPEC: 把工单上的诊断同意兑现成一条**具体的、有范围和时限的**明文查看授权。
 *
 * INTENT: `support_requests.diagnosticConsent` 此前只被收集和展示，从不兑现 ——
 *   用户勾了"同意客服诊断"，后台把这个布尔量原样显示给客服，然后没有下文。
 *   而 `viewPlaintext` 要求 SupportConsentGrant 或 LegalHold 二选一，
 *   两张表的写入又全在测试文件里，于是「查看明文」整条功能在生产环境永远 403。
 *
 * INTENT: 笼统的同意不能自动换成对任意内容的无限访问 —— 那等于用一个复选框
 *   换走一个成人内容平台上最私密的东西。所以授权必须逐条发放，并由三条边界收口：
 *   ① 目标的 owner 必须是工单提交者本人（客服不能借一张工单去看别人的内容）；
 *   ② 用户必须已经勾选 diagnosticConsent，否则这条路不开；
 *   ③ 授权有短时限与字段范围，且每次发放都写审计。
 *
 * INVARIANT: 授权的价值不在于"限制有权限的人"，而在于把"能看"从一个常驻权限
 *   变成一个**有用户同意前提、有据可查、会过期**的事件。
 */
export const supportConsentGrantRequestSchema = z
  .object({
    targetType: supportPlaintextTargetTypeSchema,
    targetId: z.string().trim().min(1).max(160),
    /** 只授权客服这次真正需要的字段，不是整条记录。 */
    fields: z.array(z.enum(["prompt", "negativePrompt"])).min(1).max(8),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();

export const supportConsentGrantResponseSchema = z
  .object({
    grant: z
      .object({
        id: adminIdSchema,
        ticketId: z.string().min(1),
        userId: adminIdSchema,
        targetType: supportPlaintextTargetTypeSchema,
        targetId: adminIdSchema,
        fields: z.array(z.string()).readonly(),
        expiresAt: adminIsoDateTimeSchema,
        createdAt: adminIsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export type SupportConsentGrantResponse = z.infer<typeof supportConsentGrantResponseSchema>;
export type SupportRequest = z.infer<typeof supportRequestSchema>;
export type SupportRequestListQuery = z.infer<typeof supportRequestListQuerySchema>;
export type SupportRequestListResponse = z.infer<typeof supportRequestListResponseSchema>;
export type SupportPlaintextViewResponse = z.infer<typeof supportPlaintextViewResponseSchema>;
