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

export const generationRequestCancelSchema = z.object({
  entityVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(300),
}).strict();

export const generationRequestCancelResultSchema = z.object({
  requestId: adminIdSchema,
  status: z.literal("cancelled"),
  version: z.number().int().positive(),
  finishedAt: adminIsoDateTimeSchema,
  refundAmount: z.number().int().nonnegative(),
}).strict();

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

export const generationJobDetailResponseSchema = z.object({
  request: generationJobListItemSchema,
  attempts: z.array(z.object({
    id: adminIdSchema,
    attemptNo: z.number().int().positive(),
    status: generationAttemptStatusSchema,
    provider: z.string().nullable(),
    profileKey: z.string().nullable(),
    profileVersion: z.number().int().positive().nullable(),
    workflowKey: z.string().nullable(),
    workflowVersion: z.number().int().positive().nullable(),
    errorClass: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorSignature: z.string().nullable(),
    retryability: z.string().nullable(),
    operatorGuidance: z.string().nullable(),
    startedAt: adminIsoDateTimeSchema.nullable(),
    finishedAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  }).strict()).readonly(),
  transportExecutions: z.array(z.object({
    id: adminIdSchema,
    attemptId: adminIdSchema,
    transportAttemptNo: z.number().int().positive(),
    provider: z.string().trim().min(1).nullable(),
    providerRequestId: z.string().trim().min(1).nullable(),
    idempotencyKey: z.string().trim().min(1).nullable(),
    status: z.enum(["running", "succeeded", "failed", "unknown"]),
    costMicros: z.number().int().nonnegative().safe().nullable(),
    manifestRef: z.string().trim().min(1).nullable(),
    startedAt: adminIsoDateTimeSchema,
    finishedAt: adminIsoDateTimeSchema.nullable(),
  }).strict()).readonly(),
  events: z.array(z.object({
    id: z.string().min(1),
    attemptId: adminIdSchema,
    sequence: z.number().int().positive(),
    eventType: z.string().min(1),
    outcome: z.string().nullable(),
    occurredAt: adminIsoDateTimeSchema,
  }).strict()).readonly(),
  artifacts: z.array(z.object({
    id: adminIdSchema,
    attemptId: adminIdSchema,
    ordinal: z.number().int().nonnegative(),
    validationState: z.string().min(1),
    archiveState: z.string().min(1),
    assetId: adminIdSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  }).strict()).readonly(),
  deliveries: z.array(z.object({
    id: adminIdSchema,
    artifactId: adminIdSchema,
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    status: z.string().min(1),
    deliveredAt: adminIsoDateTimeSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  }).strict()).readonly(),
  settlementEntries: z.array(z.object({
    ledgerEntryId: adminIdSchema,
    kind: z.string().min(1),
    deltaDreamcoins: z.number().int(),
    reason: z.string().min(1),
    createdAt: adminIsoDateTimeSchema,
  }).strict()).readonly(),
  asOf: adminIsoDateTimeSchema,
  freshness: z.literal("fresh"),
}).strict();

export const retryGenerationRequestCommandSchema = z.object({
  entityVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
  confirmation: z.string().min(1),
}).strict();

export const retryGenerationRequestResultSchema = z.object({
  commandId: adminIdSchema,
  requestId: adminIdSchema,
  attemptId: adminIdSchema,
  attemptNo: z.number().int().positive(),
  status: z.literal("queued"),
  version: z.number().int().positive(),
}).strict();

export type GenerationJobQuery = z.infer<typeof generationJobQuerySchema>;
export type GenerationJobSort = z.infer<typeof generationJobSortSchema>;
export type GenerationJobListItem = z.infer<typeof generationJobListItemSchema>;
export type GenerationJobListResponse = z.infer<typeof generationJobListResponseSchema>;
export type GenerationJobDetailResponse = z.infer<typeof generationJobDetailResponseSchema>;
export type RetryGenerationRequestCommand = z.infer<typeof retryGenerationRequestCommandSchema>;
export type RetryGenerationRequestResult = z.infer<typeof retryGenerationRequestResultSchema>;
