import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

/**
 * SPEC: 站内公告（banner）后台 CRUD 的公开契约。
 * INTENT: `confirmation` 必须等于 title（创建）或 id（改/删），但那是跨字段判断，
 *   留在 authority 里 —— 写进 schema 会让契约注册表再也生成不出合法夹具。
 * INVARIANT: JSON 内容、审计和已有 ControlPlaneCommand 幂等回执同事务提交；
 *   PATCH/DELETE 回传单条 entityVersion，不能用陈旧编辑覆盖新的公告内容。
 */

export const announcementLevelSchema = z.enum(["info", "promo", "warning"]);
const announcementReasonSchema = z.string().trim().min(3).max(2_000);
const announcementConfirmationSchema = z.string().trim().min(1).max(160);

export const announcementSchema = z
  .object({
    id: adminIdSchema,
    version: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string().min(1),
    level: announcementLevelSchema,
    active: z.boolean(),
    startsAt: adminIsoDateTimeSchema.nullable(),
    endsAt: adminIsoDateTimeSchema.nullable(),
    href: z.string().nullable(),
    createdAt: adminIsoDateTimeSchema,
    // SPEC: 此刻站上是不是真的在展示它 —— 由服务端用公开端点那条同一个判据算出来。
    // INTENT: `active` 只是三个条件里的一个，另两个是 startsAt / endsAt 的时间窗。
    //         后台过去只显示 active，于是一条窗口已过的公告在列表里是「启用」，站上却什么都没有。
    //         判据不在前端重算 —— 那正是本仓刚踩过的那类漂移（同一判据两处实现，SQL 那处取错了
    //         JSON 路径，恒为空）。这里让权威把结论直接说出来。
    serving: z.boolean(),
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
    entityVersion: z.number().int().positive(),
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
    entityVersion: z.number().int().positive(),
    reason: announcementReasonSchema.optional(),
    confirmation: announcementConfirmationSchema,
  })
  .strict();

export type Announcement = z.infer<typeof announcementSchema>;
export type AnnouncementListResponse = z.infer<typeof announcementListResponseSchema>;
