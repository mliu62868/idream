import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminCommandRequestSchema,
  adminEntityRefSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPrioritySchema,
  adminVerificationStateSchema,
} from "./common";

export const creativeRunRetryFailedCommandRequestSchema = adminCommandRequestSchema;
export const creativeRunAttachIncidentRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  incidentId: adminIdSchema,
  reason: z.string().trim().min(3).max(2_000),
}).strict();

export const creativeRunCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    purpose: z.enum([
      "character_cover",
      "character_hero",
      "character_chat",
      "feed",
      "homepage",
      "seo",
      "template_cover",
      "campaign",
      "model_eval",
    ]),
    targetType: z.enum(["character", "route_page", "campaign", "template", "none"]),
    targetId: adminIdSchema.optional(),
    profileId: adminIdSchema,
    recipeId: adminIdSchema.optional(),
    presetIds: z.array(adminIdSchema).max(12).default([]),
    orientation: z.string().trim().min(1).max(20).optional(),
    count: z.number().int().min(1).max(24).default(4),
    brief: z.string().trim().min(1).max(2_000),
    consistencyMode: z.enum(["strict", "balanced", "creative"]).default("balanced"),
    dueAt: adminIsoDateTimeSchema.optional(),
    priority: adminPrioritySchema.default("normal"),
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.targetType !== "none" && !request.targetId) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: "Target ID is required for this target type" });
    }
    if (request.targetType === "none" && request.targetId) {
      ctx.addIssue({ code: "custom", path: ["targetId"], message: "Target ID must be omitted for a targetless Run" });
    }
  });

export const creativeRunCreateResultSchema = z.object({
  batch: z.object({ id: adminIdSchema }).strict(),
  replayed: z.boolean(),
}).strict();

export const creativeReviewDecisionRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  decision: z.enum(["approved", "rejected"]),
  identityConsistency: z.enum(["passed", "failed", "unscored"]),
  score: z.number().int().min(0).max(100).optional(),
  reason: z.string().trim().min(3).max(2_000),
});

export const creativePlacementPublishRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  itemId: adminIdSchema,
  assetId: adminIdSchema,
  slot: z.string().trim().min(1).max(120),
  targetType: z.string().trim().min(1).max(120),
  targetId: adminIdSchema,
  reason: z.string().trim().min(3).max(2_000),
});

export const creativePlacementVerificationRequestSchema = z.object({
  entityVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(2_000),
});

export const creativeRunAttachIncidentResultSchema = z.object({
  runId: adminIdSchema,
  incidentId: adminIdSchema,
  relatedAttemptIds: z.array(adminIdSchema).readonly(),
  runVersion: z.number().int().positive(),
  incidentVersion: z.number().int().positive(),
}).strict();

export const creativeReviewDecisionResultSchema = z.object({
  runId: adminIdSchema,
  itemId: adminIdSchema,
  decisionId: adminIdSchema,
  decision: z.enum(["approved", "rejected"]),
  workflowStage: z.enum(["brief", "directions", "generation", "review", "placement", "verification"]),
  version: z.number().int().positive(),
}).strict();

export const creativePlacementPublishResultSchema = z.object({
  runId: adminIdSchema,
  placementId: adminIdSchema,
  verificationState: adminVerificationStateSchema,
  rollbackPlacementId: adminIdSchema.nullable(),
  runVersion: z.number().int().positive(),
}).strict();

export const creativePlacementVerificationResultSchema = z.object({
  runId: adminIdSchema,
  placementId: adminIdSchema,
  verificationState: adminVerificationStateSchema,
  checks: z.object({
    runtimeSurfaceSupported: z.boolean(),
    placementVisibleInRuntime: z.boolean(),
    renderedAssetMatches: z.boolean(),
    assetValid: z.boolean(),
  }).strict(),
  runVersion: z.number().int().positive(),
}).strict();

export const creativeLifecycleStateSchema = z.enum(["draft", "active", "closed", "archived"]);
export const creativeRunItemStatusSchema = z.enum([
  "queued",
  "generated",
  "approved",
  "rejected",
  "regenerate_requested",
  "published",
  "failed",
]);
export const creativeWorkflowStageSchema = z.enum([
  "brief",
  "directions",
  "generation",
  "review",
  "placement",
  "verification",
]);
export const creativeExecutionOutcomeSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
]);
export const creativeReviewStateSchema = z.enum(["not_ready", "pending", "in_review", "complete"]);
export const creativeDeploymentStateSchema = z.enum(["unplaced", "partially_placed", "placed"]);
export const creativeSettlementViewSchema = z.enum([
  "not_required",
  "captured",
  "partially_refunded",
  "refunded",
]);

export const creativeRetryEligibilitySchema = z
  .object({
    eligibleItemIds: z.array(adminIdSchema).readonly(),
    eligibleCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.eligibleItemIds.length !== value.eligibleCount) {
      ctx.addIssue({
        code: "custom",
        path: ["eligibleCount"],
        message: "Eligible count must match the frozen item set",
      });
    }
  });

export const creativeRunCountsSchema = z
  .object({
    generated: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    reviewed: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    placed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((counts, ctx) => {
    const issues: Array<[keyof typeof counts, boolean, string]> = [
      ["generated", counts.generated + counts.failed <= counts.total, "Generated plus failed exceeds total"],
      ["reviewed", counts.reviewed <= counts.generated, "Reviewed exceeds generated"],
      ["approved", counts.approved <= counts.reviewed, "Approved exceeds reviewed"],
      ["placed", counts.placed <= counts.approved, "Placed exceeds approved"],
    ];
    for (const [field, valid, message] of issues) {
      if (!valid) ctx.addIssue({ code: "custom", path: [field], message });
    }
  });

export type CreativeRunCounts = z.infer<typeof creativeRunCountsSchema>;
export type CreativeExecutionOutcome = z.infer<typeof creativeExecutionOutcomeSchema>;

export function deriveCreativeExecutionOutcome(
  counts: CreativeRunCounts,
): Extract<CreativeExecutionOutcome, "succeeded" | "partially_succeeded" | "failed"> {
  creativeRunCountsSchema.parse(counts);
  if (counts.total > 0 && counts.generated === counts.total) return "succeeded";
  if (counts.generated > 0) return "partially_succeeded";
  return "failed";
}

export const creativeErrorClusterSchema = z
  .object({
    signature: z.string().trim().min(1),
    errorClass: z.string().trim().min(1),
    errorCode: z.string().trim().min(1),
    retryability: z.enum(["retryable", "not_retryable", "unknown"]),
    affectedItemCount: z.number().int().positive(),
    operatorGuidance: z.string().trim().min(1),
  })
  .strict();

const creativeRunBaseSchema = z
  .object({
    id: adminIdSchema,
    purpose: z.string().trim().min(1),
    target: adminEntityRefSchema,
    ownerId: adminIdSchema.nullable(),
    dueAt: adminIsoDateTimeSchema.nullable(),
    priority: adminPrioritySchema,
    lifecycleState: creativeLifecycleStateSchema,
    workflowStage: creativeWorkflowStageSchema,
    executionOutcome: creativeExecutionOutcomeSchema,
    reviewState: creativeReviewStateSchema,
    deploymentState: creativeDeploymentStateSchema,
    verificationState: adminVerificationStateSchema,
    counts: creativeRunCountsSchema,
    errorClusters: z.array(creativeErrorClusterSchema).readonly().optional(),
    relatedIncidentIds: z.array(adminIdSchema).readonly().optional(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

function validateCreativeRunOutcome(
  run: z.infer<typeof creativeRunBaseSchema>,
  ctx: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void },
) {
    if (!creativeRunCountsSchema.safeParse(run.counts).success) return;
    if (
      ["succeeded", "partially_succeeded", "failed"].includes(run.executionOutcome) &&
      deriveCreativeExecutionOutcome(run.counts) !== run.executionOutcome
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["executionOutcome"],
        message: "Execution outcome does not match item facts",
      });
    }
}

export const creativeRunSchema = creativeRunBaseSchema.superRefine(validateCreativeRunOutcome);

export const creativeAssetLineageSchema = z
  .object({
    briefId: adminIdSchema,
    directionId: adminIdSchema,
    generationProfileKey: z.string().trim().min(1),
    generationProfileVersion: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1),
    workflowVersion: z.string().trim().min(1),
    requestId: adminIdSchema,
    attemptId: adminIdSchema,
    assetId: adminIdSchema,
    reviewDecisionId: adminIdSchema.nullable(),
    placementVersionId: adminIdSchema.nullable(),
  })
  .strict();

export const creativeRunQuerySchema = adminCursorQuerySchema.extend({
  lifecycleState: creativeLifecycleStateSchema.optional(),
  workflowStage: creativeWorkflowStageSchema.optional(),
  executionOutcome: creativeExecutionOutcomeSchema.optional(),
  ownerId: adminIdSchema.optional(),
  priority: adminPrioritySchema.optional(),
});

export const creativeRunListResponseSchema = adminListResponseSchema(creativeRunSchema);

export const creativeRunItemDetailSchema = z
  .object({
    id: adminIdSchema,
    ordinal: z.number().int().nonnegative(),
    status: creativeRunItemStatusSchema,
    version: z.number().int().nonnegative(),
    retryability: z.string(),
    lineage: z
      .object({
        requestId: adminIdSchema.nullable(),
        attemptId: adminIdSchema.nullable(),
        assetId: adminIdSchema.nullable(),
        reviewDecisionId: adminIdSchema.nullable(),
        placementVersionId: adminIdSchema.nullable(),
      })
      .strict(),
    asset: z
      .object({
        id: adminIdSchema,
        url: z.string().trim().min(1),
        thumbnailUrl: z.string().trim().min(1).nullable(),
        width: z.number().int().positive().nullable(),
        height: z.number().int().positive().nullable(),
      })
      .strict()
      .nullable(),
    review: z
      .object({
        id: adminIdSchema,
        decision: z.enum(["approved", "rejected"]),
        identityConsistency: z.enum(["passed", "failed", "unscored"]),
        score: z.number().int().min(0).max(100).nullable(),
        reason: z.string(),
        reviewerId: adminIdSchema,
        createdAt: adminIsoDateTimeSchema,
      })
      .strict()
      .nullable(),
    placement: z
      .object({
        id: adminIdSchema,
        slot: z.string(),
        targetType: z.string(),
        targetId: adminIdSchema,
        status: z.string(),
        verificationState: adminVerificationStateSchema,
        verifiedAt: adminIsoDateTimeSchema.nullable(),
        rollbackPlacementId: adminIdSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const creativeRunDetailSchema = creativeRunBaseSchema
  .omit({ errorClusters: true })
  .extend({
    title: z.string().trim().min(1),
    settlementView: creativeSettlementViewSchema,
    retryEligibility: creativeRetryEligibilitySchema,
    legacyState: z.string().trim().min(1),
    items: z.array(creativeRunItemDetailSchema).readonly(),
  })
  .strict()
  .superRefine(validateCreativeRunOutcome);

export type CreativeRun = z.infer<typeof creativeRunSchema>;
export type CreativeAssetLineage = z.infer<typeof creativeAssetLineageSchema>;
export type CreativeRunQuery = z.infer<typeof creativeRunQuerySchema>;
export type CreativeRunDetail = z.infer<typeof creativeRunDetailSchema>;
export type CreativeRunRetryFailedCommandRequest = z.infer<
  typeof creativeRunRetryFailedCommandRequestSchema
>;
export type CreativeReviewDecisionRequest = z.infer<typeof creativeReviewDecisionRequestSchema>;
export type CreativePlacementPublishRequest = z.infer<typeof creativePlacementPublishRequestSchema>;
export type CreativePlacementVerificationRequest = z.infer<typeof creativePlacementVerificationRequestSchema>;
export type CreativeRunAttachIncidentResult = z.infer<typeof creativeRunAttachIncidentResultSchema>;
export type CreativeReviewDecisionResult = z.infer<typeof creativeReviewDecisionResultSchema>;
export type CreativePlacementPublishResult = z.infer<typeof creativePlacementPublishResultSchema>;
export type CreativePlacementVerificationResult = z.infer<typeof creativePlacementVerificationResultSchema>;
