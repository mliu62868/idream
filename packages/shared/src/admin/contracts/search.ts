import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

export const globalAdminSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(160),
  limit: z.coerce.number().int().min(1).max(20).default(8),
}).strict();

export const globalAdminSearchItemSchema = z.object({
  kind: z.enum(["customer", "character", "creative_run", "case", "incident", "generation_job"]),
  id: adminIdSchema,
  title: z.string().trim().min(1),
  subtitle: z.string(),
  href: z.string().startsWith("/admin/"),
  status: z.string().trim().min(1),
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const globalAdminSearchResponseSchema = z.object({
  items: z.array(globalAdminSearchItemSchema).readonly(),
  query: z.string().trim().min(2).max(160),
  asOf: adminIsoDateTimeSchema,
}).strict();

export type GlobalAdminSearchQuery = z.infer<typeof globalAdminSearchQuerySchema>;
export type GlobalAdminSearchResponse = z.infer<typeof globalAdminSearchResponseSchema>;
