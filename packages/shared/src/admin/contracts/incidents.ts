import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminAuditEntrySchema,
  adminCommandReasonSchema,
  adminCommandRequestSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminSeveritySchema,
  adminVerificationStateSchema,
  adminJsonValueSchema,
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

export const incidentCloseRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    summary: z.string().trim().min(10),
    rootCause: z.string().trim().min(3),
    contributingFactors: z.array(z.string().trim().min(1)),
    correctiveActions: z.array(z.string().trim().min(1)).min(1),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1),
    reason: z.string().trim().min(3),
    confirmation: z.string().min(1),
  })
  .strict();

export const incidentMergeRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    sources: z.array(z.object({ incidentId: adminIdSchema, version: z.number().int().positive() }).strict()).min(1),
    reason: z.string().trim().min(3),
    confirmation: z.string().min(1),
  })
  .strict();

export const incidentSplitRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    occurrenceIds: z.array(adminIdSchema).min(1),
    reason: z.string().trim().min(3),
    confirmation: z.string().min(1),
  })
  .strict();

export const incidentRecoveryVerificationRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    entityVersion: z.number().int().nonnegative(),
    mode: z.literal("derive"),
    evidenceRefs: z.array(z.string().trim().min(1)).max(20).default([]),
  }).strict(),
  z.object({
    entityVersion: z.number().int().nonnegative(),
    mode: z.literal("override"),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1).max(20),
    overrideReason: z.string().trim().min(10).max(2_000),
  }).strict(),
]);

export const incidentRecoveryCheckSchema = z.object({
  passed: z.boolean(),
  summary: z.string().trim().min(1),
  observed: z.record(z.string(), z.unknown()),
}).strict();

export const incidentRecoveryChecksSchema = z.object({
  successRateRecovered: incidentRecoveryCheckSchema,
  signatureGrowthStopped: incidentRecoveryCheckSchema,
  backlogRecovering: incidentRecoveryCheckSchema,
  failedRequestPlanComplete: incidentRecoveryCheckSchema,
  settlementReconciled: incidentRecoveryCheckSchema,
}).strict();

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

export const adminBackfillStartRequestSchema = z
  .object({
    dryRun: z.boolean().default(true),
    cursor: z.string().trim().min(1).optional(),
    batchSize: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const adminBackfillContinuationRequestSchema = z
  .object({
    runId: adminIdSchema,
  })
  .strict();

export const adminBackfillRequestSchema = z.union([
  adminBackfillContinuationRequestSchema,
  adminBackfillStartRequestSchema,
]);

const adminBackfillCommonResultSchema = z.object({
  runId: adminIdSchema,
  status: z.enum(["paused", "completed"]),
  optionsHash: z.string().regex(/^[a-f0-9]{64}$/),
  dryRun: z.boolean(),
  scanned: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
const adminBackfillMismatchSchema = z.object({
  sourceType: z.string().trim().min(1),
  sourceId: adminIdSchema,
  reason: z.string().trim().min(1),
}).strict();

export const adminBackfillResultSchema = z.discriminatedUnion("domain", [
  adminBackfillCommonResultSchema.extend({
    domain: z.literal("generation_incident_v1"),
    unavailable: z.array(z.object({ attemptId: adminIdSchema, reason: z.string().trim().min(1) }).strict()),
    mismatches: z.array(z.object({ attemptId: adminIdSchema, reason: z.string().trim().min(1) }).strict()),
    beforeOccurrences: z.number().int().nonnegative(),
    afterOccurrences: z.number().int().nonnegative(),
  }).strict(),
  adminBackfillCommonResultSchema.extend({
    domain: z.literal("customer_case_v1"),
    unavailable: z.array(adminBackfillMismatchSchema),
    mismatches: z.array(adminBackfillMismatchSchema),
    beforeCases: z.number().int().nonnegative(),
    afterCases: z.number().int().nonnegative(),
  }).strict(),
  adminBackfillCommonResultSchema.extend({
    domain: z.literal("review_case_v1"),
    unavailable: z.array(adminBackfillMismatchSchema),
    mismatches: z.array(adminBackfillMismatchSchema),
    beforeCases: z.number().int().nonnegative(),
    afterCases: z.number().int().nonnegative(),
  }).strict(),
]);

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

export const incidentRecoveryVerificationResultSchema = z.object({
  incidentId: adminIdSchema,
  status: incidentStatusSchema,
  verificationState: adminVerificationStateSchema,
  version: z.number().int().positive(),
}).strict();

export const incidentCloseResultSchema = z.object({
  incidentId: adminIdSchema,
  postmortemId: adminIdSchema,
  status: z.literal("closed"),
  verificationState: adminVerificationStateSchema,
  version: z.number().int().positive(),
}).strict();

export const incidentTriageResultSchema = z.object({
  incidentId: adminIdSchema,
  status: incidentStatusSchema,
  severity: adminSeveritySchema,
  ownerId: adminIdSchema.nullable(),
  version: z.number().int().positive(),
}).strict();

export const incidentMergeResultSchema = z.object({
  targetIncidentId: adminIdSchema,
  mergedIncidentIds: z.array(adminIdSchema).min(1).readonly(),
  movedOccurrenceCount: z.number().int().nonnegative(),
}).strict();

export const incidentSplitResultSchema = z.object({
  sourceIncidentId: adminIdSchema,
  createdIncidentId: adminIdSchema,
  movedOccurrenceIds: z.array(adminIdSchema).min(1).readonly(),
}).strict();

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
    checks: incidentRecoveryChecksSchema.nullable(),
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

export const incidentOccurrenceAssignmentSchema = z.object({
  id: adminIdSchema,
  fromIncidentId: adminIdSchema,
  toIncidentId: adminIdSchema,
  action: z.string().trim().min(1),
  actorId: adminIdSchema,
  reason: z.string().trim().min(1),
  createdAt: adminIsoDateTimeSchema,
}).strict();

export const incidentDetailOccurrenceSchema = incidentOccurrenceSchema.extend({
  assignmentHistory: z.array(incidentOccurrenceAssignmentSchema).readonly(),
});

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
    targetVersion: z.string().trim().min(1).nullable(),
    expiresAt: adminIsoDateTimeSchema,
    createdBy: adminIdSchema,
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export const incidentPostmortemSchema = z.object({
  id: adminIdSchema,
  summary: z.string().trim().min(1),
  rootCause: z.string().trim().min(1),
  contributingFactors: adminJsonValueSchema,
  correctiveActions: adminJsonValueSchema,
  evidenceRefs: adminJsonValueSchema,
  createdById: adminIdSchema,
  createdAt: adminIsoDateTimeSchema,
}).strict();

export const incidentDetailSchema = z.object({
  incident: incidentSchema,
  occurrences: z.array(incidentDetailOccurrenceSchema).readonly(),
  actionPlans: z.array(incidentActionPlanSchema).readonly(),
  postmortem: incidentPostmortemSchema.nullable(),
  activity: z.array(adminAuditEntrySchema).readonly(),
}).strict();

export const incidentQuerySchema = adminCursorQuerySchema.extend({
  status: incidentStatusSchema.optional(),
  severity: adminSeveritySchema.optional(),
  ownerId: adminIdSchema.optional(),
});

export const incidentListResponseSchema = adminListResponseSchema(incidentSchema);

export const incidentCorrelationOutboxEventQuerySchema = z
  .object({
    status: z.literal("failed").default("failed"),
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const incidentCorrelationReplayEligibilitySchema = z.enum([
  "eligible",
  "invalid_payload",
  "attempt_missing",
  "attempt_not_correlatable",
]);

export const incidentCorrelationOutboxEventSchema = z
  .object({
    id: adminIdSchema,
    eventType: z.literal("generation.incident.correlate.v2"),
    aggregateType: z.string().trim().min(1),
    aggregateId: adminIdSchema,
    status: z.literal("failed"),
    attempts: z.number().int().nonnegative(),
    attemptId: adminIdSchema.nullable(),
    attemptStatus: z.string().trim().min(1).nullable(),
    replayEligibility: incidentCorrelationReplayEligibilitySchema,
    lastErrorCode: z.string().trim().min(1).nullable(),
    lastErrorMessage: z.string().trim().min(1).nullable(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    nextRunAt: adminIsoDateTimeSchema,
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const incidentCorrelationOutboxEventListResponseSchema =
  adminListResponseSchema(incidentCorrelationOutboxEventSchema);

export const INCIDENT_CORRELATION_REPLAY_CONFIRMATION =
  "REPLAY_INCIDENT_CORRELATION_FAILED" as const;

export const incidentCorrelationOutboxReplayRequestSchema = z
  .object({
    events: z
      .array(z.object({
        id: adminIdSchema,
        expectedAttempts: z.number().int().nonnegative(),
        expectedUpdatedAt: adminIsoDateTimeSchema,
        expectedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
      }).strict())
      .min(1)
      .max(100),
    reason: adminCommandReasonSchema,
    confirmation: z.literal(INCIDENT_CORRELATION_REPLAY_CONFIRMATION),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.events.forEach((event, index) => {
      if (seen.has(event.id)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: "event ids must be unique",
        });
      }
      seen.add(event.id);
    });
  });

export const incidentCorrelationOutboxReplayOutcomeSchema = z.enum([
  "requeued",
  "already_delivered",
  "already_requeued",
  "stale",
  "payload_hash_mismatch",
  "invalid_payload",
  "attempt_missing",
  "attempt_not_correlatable",
  "not_found",
]);

export const incidentCorrelationOutboxReplayResultSchema = z
  .object({
    results: z.array(z.object({
      id: adminIdSchema,
      outcome: incidentCorrelationOutboxReplayOutcomeSchema,
      priorAttempts: z.number().int().nonnegative().nullable(),
      payloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict()).readonly(),
    requeuedCount: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();

export const INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION =
  "DISCARD_INCIDENT_CORRELATION_ATTEMPT_MISSING" as const;

export const incidentCorrelationOutboxAttemptMissingDiscardRequestSchema = z
  .object({
    id: adminIdSchema,
    expectedAttempts: z.number().int().nonnegative(),
    expectedUpdatedAt: adminIsoDateTimeSchema,
    expectedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedAttemptId: adminIdSchema,
    reason: adminCommandReasonSchema,
    confirmation: z.literal(
      INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION,
    ),
  })
  .strict();

export const incidentCorrelationOutboxAttemptMissingDiscardOutcomeSchema = z.enum([
  "discarded_target_missing",
  "already_discarded_target_missing",
  "already_delivered",
  "already_requeued",
  "stale",
  "payload_hash_mismatch",
  "invalid_payload",
  "attempt_id_mismatch",
  "attempt_present",
  "not_found",
]);

export const incidentCorrelationOutboxAttemptMissingDiscardResultSchema = z
  .object({
    id: adminIdSchema,
    outcome: incidentCorrelationOutboxAttemptMissingDiscardOutcomeSchema,
    priorAttempts: z.number().int().nonnegative().nullable(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    replayed: z.boolean(),
  })
  .strict();

export type OpsIncident = z.infer<typeof incidentSchema>;
export type IncidentOccurrence = z.infer<typeof incidentOccurrenceSchema>;
export type IncidentActionPlan = z.infer<typeof incidentActionPlanSchema>;
export type IncidentQuery = z.infer<typeof incidentQuerySchema>;
export type IncidentCorrelationOutboxEvent = z.infer<
  typeof incidentCorrelationOutboxEventSchema
>;
export type IncidentCorrelationOutboxEventListResponse = z.infer<
  typeof incidentCorrelationOutboxEventListResponseSchema
>;
export type IncidentCorrelationOutboxEventQuery = z.infer<
  typeof incidentCorrelationOutboxEventQuerySchema
>;
export type IncidentCorrelationOutboxReplayRequest = z.infer<
  typeof incidentCorrelationOutboxReplayRequestSchema
>;
export type IncidentCorrelationOutboxReplayResult = z.infer<
  typeof incidentCorrelationOutboxReplayResultSchema
>;
export type IncidentCorrelationOutboxAttemptMissingDiscardRequest = z.infer<
  typeof incidentCorrelationOutboxAttemptMissingDiscardRequestSchema
>;
export type IncidentCorrelationOutboxAttemptMissingDiscardResult = z.infer<
  typeof incidentCorrelationOutboxAttemptMissingDiscardResultSchema
>;
export type IncidentResolveCommandRequest = z.infer<typeof incidentResolveCommandRequestSchema>;
export type IncidentTriageRequest = z.infer<typeof incidentTriageRequestSchema>;
export type IncidentRecoveryVerificationRequest = z.infer<
  typeof incidentRecoveryVerificationRequestSchema
>;
export type IncidentRecoveryVerificationResult = z.infer<
  typeof incidentRecoveryVerificationResultSchema
>;
export type IncidentActionPlanPreviewRequest = z.infer<
  typeof incidentActionPlanPreviewRequestSchema
>;
export type IncidentActionPlanExecuteRequest = z.infer<
  typeof incidentActionPlanExecuteRequestSchema
>;
export type AdminBackfillRequest = z.infer<typeof adminBackfillRequestSchema>;
export type AdminBackfillStartRequest = z.infer<typeof adminBackfillStartRequestSchema>;
export type AdminBackfillResult = z.infer<typeof adminBackfillResultSchema>;
