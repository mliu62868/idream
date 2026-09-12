import { z } from "zod";
import { comicDecisionSchema, comicDetailSchema, comicListSchema, comicStatusSchema } from "../../comics";

export const adminComicQuerySchema = z.object({
  status: comicStatusSchema.default("pending_review"),
  limit: z.coerce.number().int().min(1).max(24).default(12),
  cursor: z.string().max(2000).optional(),
}).strict();
export const adminComicDecisionRequestSchema = comicDecisionSchema.extend({
  confirmation: z.string().min(1).max(128),
}).strict();
export const adminComicDetailResponseSchema = comicDetailSchema;
export const adminComicListResponseSchema = comicListSchema;
