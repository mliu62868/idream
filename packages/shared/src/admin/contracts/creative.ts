import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminEntityRefSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPrioritySchema,
  adminVerificationStateSchema,
} from "./common";

export const creativeLifecycleStateSchema = z.enum(["draft", "active", "closed", "archived"]);
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

export const creativeRunSchema = z
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
  .strict()
  .superRefine((run, ctx) => {
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
  });

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

export type CreativeRun = z.infer<typeof creativeRunSchema>;
export type CreativeAssetLineage = z.infer<typeof creativeAssetLineageSchema>;
export type CreativeRunQuery = z.infer<typeof creativeRunQuerySchema>;
