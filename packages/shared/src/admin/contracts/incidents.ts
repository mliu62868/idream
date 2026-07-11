import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminCommandRequestSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminSeveritySchema,
  adminVerificationStateSchema,
} from "./common";

export const incidentResolveCommandRequestSchema = adminCommandRequestSchema;

export const incidentTriageRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    ownerId: adminIdSchema.nullable(),
    severity: adminSeveritySchema.optional(),
    slaDueAt: adminIsoDateTimeSchema.optional(),
    suspectedCause: z.string().trim().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    runbookUrl: z.string().url().optional(),
    rollbackTarget: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1),
  })
  .strict();

export const incidentRecoveryVerificationRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    state: z.enum(["passed", "failed", "overridden"]),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1),
    checks: z
      .object({
        successRateRecovered: z.boolean(),
        signatureGrowthStopped: z.boolean(),
        backlogRecovering: z.boolean(),
        failedRequestPlanComplete: z.boolean(),
        settlementReconciled: z.boolean(),
      })
      .strict(),
    overrideReason: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "overridden" && !value.overrideReason) {
      ctx.addIssue({ code: "custom", path: ["overrideReason"], message: "Override reason is required" });
    }
  });

export const incidentActionPlanPreviewRequestSchema = z
  .object({
    action: z.enum(["retry_eligible", "refund", "pause_route", "rollback"]),
    targetVersion: z.string().trim().min(1).optional(),
    ttlSeconds: z.number().int().min(1).max(3600).optional(),
  })
  .strict();

export const incidentActionPlanExecuteRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    confirmation: z.string().trim().min(1),
  })
  .strict();

export const adminBackfillRequestSchema = z
  .object({
    dryRun: z.boolean().default(true),
    cursor: z.string().trim().min(1).optional(),
    batchSize: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const incidentStatusSchema = z.enum([
  "detected",
  "triaged",
  "mitigating",
  "monitoring",
  "resolved",
  "closed",
  "duplicate",
  "merged",
]);

export const incidentImpactSchema = z
  .object({
    affectedRequests: z.number().int().nonnegative(),
    affectedUsers: z.number().int().nonnegative(),
    failedCostMicros: z.number().int().nonnegative(),
    refundMicros: z.number().int().nonnegative(),
    refundDreamcoins: z.number().int().nonnegative().optional(),
  })
  .strict();

export const recoveryVerificationSchema = z
  .object({
    state: adminVerificationStateSchema,
    checkedAt: adminIsoDateTimeSchema.nullable(),
    evidenceRefs: z.array(z.string().trim().min(1)).readonly(),
  })
  .strict();

export const incidentSchema = z
  .object({
    id: adminIdSchema,
    signature: z.string().trim().min(1),
    signatureVersion: z.string().trim().min(1),
    status: incidentStatusSchema,
    severity: adminSeveritySchema,
    ownerId: adminIdSchema.nullable(),
    firstSeenAt: adminIsoDateTimeSchema,
    lastSeenAt: adminIsoDateTimeSchema,
    impact: incidentImpactSchema,
    lastKnownGoodAt: adminIsoDateTimeSchema.nullable().optional(),
    slaDueAt: adminIsoDateTimeSchema.nullable().optional(),
    suspectedCause: z.string().trim().min(1).nullable(),
    causeConfidence: z.number().min(0).max(1).nullable(),
    recommendedActions: z.array(z.string().trim().min(1)).readonly(),
    runbookUrl: z.string().trim().min(1).nullable(),
    rollbackTarget: z.string().trim().min(1).nullable(),
    recoveryVerification: recoveryVerificationSchema,
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const incidentOccurrenceSchema = z
  .object({
    id: adminIdSchema,
    incidentId: adminIdSchema,
    requestId: adminIdSchema,
    attemptId: adminIdSchema.nullable(),
    transportExecutionId: adminIdSchema.nullable(),
    observedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const incidentActionPlanSchema = z
  .object({
    id: adminIdSchema,
    incidentId: adminIdSchema,
    incidentVersion: z.number().int().nonnegative(),
    action: z.enum(["retry_eligible", "refund", "pause_route", "rollback"]),
    eligibleOccurrenceIds: z.array(adminIdSchema).readonly(),
    skippedOccurrenceIds: z.array(adminIdSchema).readonly(),
    occurrenceSetHash: z.string().trim().min(1),
    impact: incidentImpactSchema,
    expiresAt: adminIsoDateTimeSchema,
    createdBy: adminIdSchema,
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const incidentQuerySchema = adminCursorQuerySchema.extend({
  status: incidentStatusSchema.optional(),
  severity: adminSeveritySchema.optional(),
  ownerId: adminIdSchema.optional(),
});

export const incidentListResponseSchema = adminListResponseSchema(incidentSchema);

export type OpsIncident = z.infer<typeof incidentSchema>;
export type IncidentOccurrence = z.infer<typeof incidentOccurrenceSchema>;
export type IncidentActionPlan = z.infer<typeof incidentActionPlanSchema>;
export type IncidentQuery = z.infer<typeof incidentQuerySchema>;
export type IncidentResolveCommandRequest = z.infer<typeof incidentResolveCommandRequestSchema>;
export type IncidentTriageRequest = z.infer<typeof incidentTriageRequestSchema>;
export type IncidentRecoveryVerificationRequest = z.infer<
  typeof incidentRecoveryVerificationRequestSchema
>;
export type IncidentActionPlanPreviewRequest = z.infer<
  typeof incidentActionPlanPreviewRequestSchema
>;
export type IncidentActionPlanExecuteRequest = z.infer<
  typeof incidentActionPlanExecuteRequestSchema
>;
export type AdminBackfillRequest = z.infer<typeof adminBackfillRequestSchema>;
