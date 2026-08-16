import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

/**
 * SPEC: 站内公告（banner）后台 CRUD 的公开契约。
 * INTENT: `confirmation` 必须等于 title（创建）或 id（改/删），但那是跨字段判断，
 *   留在 authority 里 —— 写进 schema 会让契约注册表再也生成不出合法夹具。
 * INVARIANT: 写操作不声明 idempotency-key。公告存在 AppSetting 的一个 JSON 数组里，
 *   没有可去重的命令表；声明一个不执行的幂等头正是 v2 要消灭的那种契约。
 */

export const announcementLevelSchema = z.enum(["info", "promo", "warning"]);
const announcementReasonSchema = z.string().trim().min(3).max(2_000);
const announcementConfirmationSchema = z.string().trim().min(1).max(160);

export const announcementSchema = z
  .object({
    id: adminIdSchema,
    title: z.string().min(1),
    body: z.string().min(1),
    level: announcementLevelSchema,
    active: z.boolean(),
    startsAt: adminIsoDateTimeSchema.nullable(),
    endsAt: adminIsoDateTimeSchema.nullable(),
    href: z.string().nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const announcementListQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    level: announcementLevelSchema.optional(),
    active: z.enum(["true", "false"]).optional(),
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const announcementListResponseSchema = z
  .object({
    items: z.array(announcementSchema).readonly(),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export const announcementMutationResponseSchema = z
  .object({ announcement: announcementSchema })
  .strict();

export const announcementDeleteResponseSchema = z
  .object({ deleted: z.literal(true) })
  .strict();

export const announcementCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(2_000),
    level: announcementLevelSchema.default("info"),
    active: z.boolean().default(false),
    startsAt: adminIsoDateTimeSchema.nullable().optional(),
    endsAt: adminIsoDateTimeSchema.nullable().optional(),
    href: z.string().trim().max(512).nullable().optional(),
    reason: announcementReasonSchema,
    confirmation: announcementConfirmationSchema,
  })
  .strict();

export const announcementPatchRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    body: z.string().trim().min(1).max(2_000).optional(),
    level: announcementLevelSchema.optional(),
    active: z.boolean().optional(),
    startsAt: adminIsoDateTimeSchema.nullable().optional(),
    endsAt: adminIsoDateTimeSchema.nullable().optional(),
    href: z.string().trim().max(512).nullable().optional(),
    reason: announcementReasonSchema,
    confirmation: announcementConfirmationSchema,
  })
  .strict();

export const announcementDeleteRequestSchema = z
  .object({
    reason: announcementReasonSchema.optional(),
    confirmation: announcementConfirmationSchema,
  })
  .strict();

export type Announcement = z.infer<typeof announcementSchema>;
export type AnnouncementListResponse = z.infer<typeof announcementListResponseSchema>;
