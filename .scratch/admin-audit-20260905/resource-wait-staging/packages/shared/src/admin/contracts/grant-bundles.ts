import { z } from "zod";
import { adminPermissionKeySchema } from "../permissions";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

export const adminGrantBundleKeySchema = z.enum([
  "character_producer",
  "creative_operator",
  "growth_operator",
]);

export const adminGrantBundleScopeSchema = z.object({
  characterIds: z.array(adminIdSchema).max(500).default([]),
}).strict();

export const adminGrantBundleWriteSchema = z.object({
  bundleKey: adminGrantBundleKeySchema,
  scope: adminGrantBundleScopeSchema.optional(),
  expiresAt: adminIsoDateTimeSchema.nullable().optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(300),
}).strict();

export const adminGrantBundleRevokeSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(300),
}).strict();

export const adminGrantBundleSchema = z.object({
  id: adminIdSchema,
  userId: adminIdSchema,
  bundleKey: adminGrantBundleKeySchema,
  scope: adminGrantBundleScopeSchema.nullable(),
  expiresAt: adminIsoDateTimeSchema.nullable(),
  revokedAt: adminIsoDateTimeSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
  state: z.enum(["active", "expired", "revoked"]),
  permissions: z.array(adminPermissionKeySchema).readonly(),
}).strict();

export const adminGrantBundleListSchema = z.object({
  user: z.object({
    id: adminIdSchema,
    role: z.string().trim().min(1),
    status: z.string().trim().min(1),
  }).strict(),
  items: z.array(adminGrantBundleSchema).readonly(),
}).strict();

export const adminGrantBundleMutationSchema = z.object({
  bundle: adminGrantBundleSchema,
}).strict();

export type AdminGrantBundleWrite = z.infer<typeof adminGrantBundleWriteSchema>;
export type AdminGrantBundleRevoke = z.infer<typeof adminGrantBundleRevokeSchema>;
export type AdminGrantBundle = z.infer<typeof adminGrantBundleSchema>;
