import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

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

export type SupportRequest = z.infer<typeof supportRequestSchema>;
export type SupportRequestListQuery = z.infer<typeof supportRequestListQuerySchema>;
export type SupportRequestListResponse = z.infer<typeof supportRequestListResponseSchema>;
export type SupportPlaintextViewResponse = z.infer<typeof supportPlaintextViewResponseSchema>;
