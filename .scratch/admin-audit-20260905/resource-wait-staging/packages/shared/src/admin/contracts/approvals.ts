import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

/**
 * SPEC: 双人审批（dual approval）请求的公开契约。
 * INTENT: 请求方持有目标权限、审批方与请求方必须不同、已裁决不可再裁决 —— 这三条依然由
 *         服务端强制；契约负责的是「一条审批请求长什么样」，让运营台不必再对 Prisma 行猜形状。
 */

export const approvalRequestSchema = z
  .object({
    id: adminIdSchema,
    requestedById: adminIdSchema,
    approvedById: adminIdSchema.nullable(),
    permissionKey: z.string().min(1),
    action: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    status: z.string().min(1),
    reason: z.string().nullable(),
    createdAt: adminIsoDateTimeSchema,
    decidedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const approvalListQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    status: z.string().trim().min(1).max(40).default("pending"),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    cursor: z.string().trim().min(1).optional(),
    before: z.string().trim().min(1).optional(),
  })
  .strict();

export const approvalListResponseSchema = z
  .object({
    items: z.array(approvalRequestSchema),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export const approvalCreateRequestSchema = z
  .object({
    permissionKey: z.string().trim().min(1).max(80),
    action: z.string().trim().min(1).max(120),
    targetType: z.string().trim().min(1).max(80),
    targetId: z.string().trim().min(1).max(160),
    payload: z.record(z.string(), z.unknown()).default({}),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const approvalDecisionRequestSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1).max(160),
  })
  .strict();

export const approvalMutationResponseSchema = z
  .object({ request: approvalRequestSchema })
  .strict();
