import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
} from "./common";

export const generationJobModeSchema = z.enum(["image", "video"]);
export const generationJobStatusSchema = z.enum([
  "queued",
  "moderating_input",
  "running",
  "moderating_output",
  "completed",
  "failed",
  "blocked",
  "refunded",
  "cancelled",
]);
export const generationJobSortSchema = z.enum([
  "created_desc",
  "created_asc",
  "updated_desc",
  "cost_desc",
]);
export const generationRequestOutcomeSchema = z.enum([
  "accepted",
  "processing",
  "needs_reconciliation",
  "succeeded",
  "partially_succeeded",
  "failed",
  "blocked",
  "cancelled",
]);
export const generationAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export const generationSettlementViewSchema = z.enum([
  "not_required",
  "captured",
  "partially_refunded",
  "refunded",
]);

export const generationJobQuerySchema = adminCursorQuerySchema.extend({
  mode: z.enum(["all", "image", "video"]).default("image"),
  legacyStatus: generationJobStatusSchema.optional(),
  provider: z.string().trim().min(1).max(120).optional(),
  sourceType: z.string().trim().min(1).max(120).optional(),
  userId: adminIdSchema.optional(),
  characterId: adminIdSchema.optional(),
  sort: generationJobSortSchema.default("created_desc"),
});

export const generationJobListItemSchema = z
  .object({
    id: adminIdSchema,
    userId: adminIdSchema,
    characterId: adminIdSchema.nullable(),
    derivedFromJobId: adminIdSchema.nullable(),
    mode: generationJobModeSchema,
    requestOutcome: generationRequestOutcomeSchema,
    legacyStatus: generationJobStatusSchema,
    latestAttempt: z.object({
      id: adminIdSchema,
      attemptNo: z.number().int().positive(),
      status: generationAttemptStatusSchema,
      provider: z.string().trim().min(1).nullable(),
      errorCode: z.string().trim().min(1).nullable(),
      retryability: z.string().trim().min(1).nullable(),
      operatorGuidance: z.string().trim().min(1).nullable(),
      startedAt: adminIsoDateTimeSchema.nullable(),
      finishedAt: adminIsoDateTimeSchema.nullable(),
    }).strict().nullable(),
    delivery: z.object({
      expectedOutputCount: z.number().int().nonnegative(),
      deliveredCount: z.number().int().nonnegative(),
      pendingCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      suppressedCount: z.number().int().nonnegative(),
    }).strict(),
    settlement: z.object({
      view: generationSettlementViewSchema,
      capturedDreamcoins: z.number().int().nonnegative(),
      refundedDreamcoins: z.number().int().nonnegative(),
    }).strict(),
    provider: z.string().trim().min(1).nullable(),
    model: z.string().trim().min(1).nullable(),
    profileId: adminIdSchema.nullable(),
    profileVersion: z.number().int().positive().nullable(),
    recipeId: adminIdSchema.nullable(),
    recipeVersion: z.number().int().positive().nullable(),
    sourceType: z.string().trim().min(1),
    sourceId: z.string().trim().min(1).nullable(),
    errorCode: z.string().trim().min(1).nullable(),
    outputCount: z.number().int().nonnegative(),
    deliveredOutputCount: z.number().int().nonnegative(),
    assetCount: z.number().int().nonnegative(),
    costDreamcoins: z.number().int().nonnegative(),
    promptHidden: z.boolean(),
    negativePromptHidden: z.boolean(),
    version: z.number().int().positive(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
    finishedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const generationJobFacetValueSchema = z
  .object({
    value: z.string().trim().min(1),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const generationJobFacetsSchema = z
  .object({
    legacyStatuses: z.array(generationJobFacetValueSchema).readonly(),
    modes: z.array(generationJobFacetValueSchema).readonly(),
    providers: z.array(generationJobFacetValueSchema).readonly(),
    sourceTypes: z.array(generationJobFacetValueSchema).readonly(),
  })
  .strict();

export const generationJobSummarySchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    totalCostDreamcoins: z.number().int().nonnegative(),
    totalOutputCount: z.number().int().nonnegative(),
    totalDeliveredOutputCount: z.number().int().nonnegative(),
  })
  .strict();

export const generationJobListResponseSchema = adminListResponseSchema(
  generationJobListItemSchema,
  generationJobFacetsSchema,
  generationJobSummarySchema,
).extend({
  facets: generationJobFacetsSchema,
  summary: generationJobSummarySchema,
});

export type GenerationJobQuery = z.infer<typeof generationJobQuerySchema>;
export type GenerationJobSort = z.infer<typeof generationJobSortSchema>;
export type GenerationJobListItem = z.infer<typeof generationJobListItemSchema>;
export type GenerationJobListResponse = z.infer<typeof generationJobListResponseSchema>;
