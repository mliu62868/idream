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
