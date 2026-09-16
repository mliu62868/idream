import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema, adminPageInfoSchema } from "./common";

export const affiliateApplicationListQuerySchema = z.object({
  status: z.enum(["all", "pending", "approved", "rejected"]).default("pending"),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export const affiliateApplicationAdminSchema = z.object({
  id: adminIdSchema,
  userId: adminIdSchema,
  status: z.enum(["pending", "approved", "rejected"]),
  termsVersion: z.string(),
  channels: z.array(z.string()),
  reviewNote: z.string().nullable(),
  reviewedAt: adminIsoDateTimeSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const affiliateApplicationListResponseSchema = z.object({
  items: z.array(affiliateApplicationAdminSchema),
  pageInfo: adminPageInfoSchema,
}).strict();

export const affiliateApplicationDecisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  expectedUpdatedAt: adminIsoDateTimeSchema,
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
}).strict();

export const affiliateApplicationMutationResponseSchema = z.object({
  item: affiliateApplicationAdminSchema,
  replayed: z.boolean(),
}).strict();

export type AffiliateApplicationAdmin = z.infer<typeof affiliateApplicationAdminSchema>;
