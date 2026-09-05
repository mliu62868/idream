import { z } from "zod";
import { adminAuditEntrySchema, adminPageInfoSchema } from "./common";

export const auditLogQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    action: z.string().trim().min(1).max(160).optional(),
    actorId: z.string().trim().min(1).max(160).optional(),
    targetType: z.string().trim().min(1).max(160).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(80),
    cursor: z.string().trim().min(1).optional(),
    before: z.string().trim().min(1).optional(),
  })
  .strict();

export const auditLogListResponseSchema = z
  .object({
    items: z.array(adminAuditEntrySchema).readonly(),
    pageInfo: adminPageInfoSchema,
  })
  .strict();

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;
