import { z } from "zod";
import { packBlockSchema, packDetailSchema, packListSchema, packStatusSchema } from "../../packs";

export const adminPackQuerySchema = z.object({
  status: packStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(24).default(12),
  cursor: z.string().max(2000).optional(),
}).strict();
export const adminPackBlockRequestSchema = packBlockSchema;
export const adminPackDetailResponseSchema = packDetailSchema;
export const adminPackListResponseSchema = packListSchema;
