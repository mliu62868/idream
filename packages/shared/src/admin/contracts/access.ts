import { z } from "zod";
import {
  adminDataClassSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
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

export type AccessUserListItem = z.infer<typeof accessUserListItemSchema>;
export type AccessUserListQuery = z.infer<typeof accessUserListQuerySchema>;
export type AccessUserListResponse = z.infer<typeof accessUserListResponseSchema>;
