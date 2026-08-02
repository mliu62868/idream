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
  "blocked",
  "cancelled",
  "unknown",
]);
export const generationTransportExecutionStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "unknown",
]);
export const generationArtifactValidationStateSchema = z.enum([
  "produced",
  "valid",
  "invalid",
  "rejected",
  "late_after_failed",
  "late_after_blocked",
  "late_after_cancelled",
  "late_after_refunded",
  "late_after_unknown",
]);
export const generationArtifactArchiveStateSchema = z.enum(["active", "archived"]);
export const generationDeliveryStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
  "suppressed",
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
    unknownReview: z.object({
      status: z.enum(["not_applicable", "scheduled", "due"]),
      nextReviewAt: adminIsoDateTimeSchema.nullable(),
    }).strict(),
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

export const generationJobDataScopeSchema = z
  .object({
    kind: z.literal("operational"),
    includedDataClasses: z.tuple([
      z.literal("customer"),
      z.literal("internal"),
    ]),
    excludedDataClasses: z.tuple([
      z.literal("fixture"),
      z.literal("audit"),
    ]),
  })
  .strict();

export const generationJobListResponseSchema = adminListResponseSchema(
  generationJobListItemSchema,
  generationJobFacetsSchema,
  generationJobSummarySchema,
).extend({
  facets: generationJobFacetsSchema,
  summary: generationJobSummarySchema,
  dataScope: generationJobDataScopeSchema,
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
    status: generationTransportExecutionStatusSchema,
    latencyMs: z.number().int().nonnegative().nullable(),
    costMicros: z.number().int().nonnegative().safe().nullable(),
    pricingVersion: z.string().trim().min(1).nullable(),
    terminalRecordRef: z.string().trim().min(1).nullable(),
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
    validationState: generationArtifactValidationStateSchema,
    archiveState: generationArtifactArchiveStateSchema,
    assetId: adminIdSchema.nullable(),
    createdAt: adminIsoDateTimeSchema,
  }).strict()).readonly(),
  deliveries: z.array(z.object({
    id: adminIdSchema,
    artifactId: adminIdSchema,
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    status: generationDeliveryStatusSchema,
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
  unknownReconciliations: z.array(z.object({
    id: adminIdSchema,
    attemptId: adminIdSchema,
    resolution: z.enum(["adopt_succeeded", "confirm_failed", "remain_unknown"]),
    actorId: adminIdSchema,
    reason: z.string().trim().min(3),
    providerEvidenceRefs: z.array(z.string().trim().min(3)).readonly(),
    nextReviewAt: adminIsoDateTimeSchema.nullable(),
    reviewStatus: z.enum(["not_applicable", "scheduled", "due"]),
    refundAmount: z.number().int().nonnegative(),
    deliveredCount: z.number().int().nonnegative(),
    occurredAt: adminIsoDateTimeSchema,
  }).strict()).readonly(),
  unknownTerminalEvidence: z.object({
    attemptId: adminIdSchema,
    outcome: z.enum(["succeeded", "failed", "blocked", "unknown"]),
    transportStatus: generationTransportExecutionStatusSchema,
    terminalRecordRef: z.string().trim().min(1),
    terminalRecordChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    artifactCount: z.number().int().nonnegative(),
    adoptable: z.boolean(),
    adoptionBlockReason: z.enum([
      "request_already_refunded",
      "request_not_reconcilable",
    ]).nullable(),
  }).strict().nullable(),
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

const unknownGenerationReconciliationBaseSchema = z.object({
  entityVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(2_000),
  providerEvidenceRefs: z.array(
    z.string().trim().min(3).max(1_000),
  ).min(1).max(20),
  confirmation: z.string().trim().min(1).max(300),
});

// SPEC: An unknown Attempt is immutable provider-outcome evidence. Operators
// may settle its Request, or explicitly keep it open for a scheduled review;
// neither command rewrites the Attempt terminal fact.
export const unknownGenerationReconciliationCommandSchema = z.discriminatedUnion(
  "resolution",
  [
    unknownGenerationReconciliationBaseSchema.extend({
      resolution: z.literal("adopt_succeeded"),
    }).strict(),
    unknownGenerationReconciliationBaseSchema.extend({
      resolution: z.literal("confirm_failed"),
    }).strict(),
    unknownGenerationReconciliationBaseSchema.extend({
      resolution: z.literal("remain_unknown"),
      nextReviewAt: adminIsoDateTimeSchema,
    }).strict(),
  ],
);

export const unknownGenerationReconciliationResultSchema = z.discriminatedUnion(
  "resolution",
  [
    z.object({
      commandId: adminIdSchema,
      requestId: adminIdSchema,
      attemptId: adminIdSchema,
      attemptStatus: z.literal("unknown"),
      resolution: z.literal("adopt_succeeded"),
      requestStatus: z.literal("completed"),
      version: z.number().int().positive(),
      refundAmount: z.number().int().nonnegative(),
      deliveredCount: z.number().int().positive(),
      nextReviewAt: z.null(),
      reconciledAt: adminIsoDateTimeSchema,
    }).strict(),
    z.object({
      commandId: adminIdSchema,
      requestId: adminIdSchema,
      attemptId: adminIdSchema,
      attemptStatus: z.literal("unknown"),
      resolution: z.literal("confirm_failed"),
      requestStatus: z.literal("failed"),
      version: z.number().int().positive(),
      refundAmount: z.number().int().nonnegative(),
      deliveredCount: z.literal(0),
      nextReviewAt: z.null(),
      reconciledAt: adminIsoDateTimeSchema,
    }).strict(),
    z.object({
      commandId: adminIdSchema,
      requestId: adminIdSchema,
      attemptId: adminIdSchema,
      attemptStatus: z.literal("unknown"),
      resolution: z.literal("remain_unknown"),
      requestStatus: z.enum([
        "queued",
        "moderating_input",
        "running",
        "moderating_output",
        "failed",
      ]),
      version: z.number().int().positive(),
      refundAmount: z.literal(0),
      deliveredCount: z.literal(0),
      nextReviewAt: adminIsoDateTimeSchema,
      reconciledAt: adminIsoDateTimeSchema,
    }).strict(),
  ],
);

export type GenerationJobQuery = z.infer<typeof generationJobQuerySchema>;
export type GenerationJobSort = z.infer<typeof generationJobSortSchema>;
export type GenerationJobListItem = z.infer<typeof generationJobListItemSchema>;
export type GenerationJobListResponse = z.infer<typeof generationJobListResponseSchema>;
export type GenerationJobDetailResponse = z.infer<typeof generationJobDetailResponseSchema>;
export type RetryGenerationRequestCommand = z.infer<typeof retryGenerationRequestCommandSchema>;
export type RetryGenerationRequestResult = z.infer<typeof retryGenerationRequestResultSchema>;
export type UnknownGenerationReconciliationCommand = z.infer<
  typeof unknownGenerationReconciliationCommandSchema
>;
export type UnknownGenerationReconciliationResult = z.infer<
  typeof unknownGenerationReconciliationResultSchema
>;
