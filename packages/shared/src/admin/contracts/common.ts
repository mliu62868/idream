import { z } from "zod";

export const adminIdSchema = z.string().trim().min(1);
export const adminIsoDateTimeSchema = z.string().datetime({ offset: true });
export const adminJsonValueSchema = z.json();

export const adminEnvironmentSchema = z.enum(["production", "staging", "development", "test"]);
export const adminDataClassSchema = z.enum(["customer", "internal", "fixture", "audit"]);
export const adminFreshnessSchema = z.enum(["fresh", "stale", "degraded"]);
export const adminSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const adminPrioritySchema = z.enum(["urgent", "high", "normal", "low"]);
export const adminReadinessSchema = z.enum(["ready", "blocked", "stale", "unknown"]);
export const adminVerificationStateSchema = z.enum([
  "pending",
  "verifying",
  "passed",
  "failed",
  "overridden",
]);
export const adminControlPlaneCommandStatusSchema = z.enum([
  "accepted",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export const adminControlPlaneCommandAttemptStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
]);

export const adminEntityRefSchema = z
  .object({
    type: z.string().trim().min(1),
    id: adminIdSchema,
  })
  .strict();

export const dataQualityIssueSchema = z
  .object({
    code: z.string().trim().min(1),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().trim().min(1),
    field: z.string().trim().min(1).optional(),
    deepLink: z.string().trim().min(1).optional(),
  })
  .strict();

export const checkResultSchema = z
  .object({
    key: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    result: z.enum(["passed", "failed", "warning", "unknown"]),
    message: z.string().trim().min(1),
    evidenceRefs: z.array(z.string().trim().min(1)).readonly().default([]),
    checkedAt: adminIsoDateTimeSchema.nullable(),
  })
  .strict();

export const blockerSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    checkKey: z.string().trim().min(1).optional(),
    deepLink: z.string().trim().min(1).optional(),
  })
  .strict();

export const operationalStateViewSchema = z
  .object({
    workflowState: z.string().trim().min(1),
    servingState: z.string().trim().min(1).optional(),
    qualityState: z.string().trim().min(1).optional(),
    executionOutcome: z.string().trim().min(1).optional(),
    readiness: adminReadinessSchema,
    checks: z.array(checkResultSchema).readonly(),
    blockers: z.array(blockerSchema).readonly(),
    verificationState: adminVerificationStateSchema.optional(),
    policyVersion: z.string().trim().min(1),
    entityVersion: z.number().int().nonnegative(),
    lastVerifiedAt: adminIsoDateTimeSchema.nullable(),
    legacyState: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminPageInfoSchema = z
  .object({
    endCursor: z.string().min(1).nullable(),
    hasNextPage: z.boolean(),
  })
  .strict();

export interface AdminListResponse<T, TFacet = unknown, TSummary = unknown> {
  items: readonly T[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
  facets?: TFacet;
  summary?: TSummary;
  asOf: string;
  freshness: z.infer<typeof adminFreshnessSchema>;
  dataQuality?: readonly z.infer<typeof dataQualityIssueSchema>[];
}

export function adminListResponseSchema<
  TItem extends z.ZodType,
  TFacet extends z.ZodType = z.ZodUnknown,
  TSummary extends z.ZodType = z.ZodUnknown,
>(item: TItem, facets?: TFacet, summary?: TSummary) {
  return z
    .object({
      items: z.array(item).readonly(),
      pageInfo: adminPageInfoSchema,
      facets: (facets ?? z.unknown()).optional(),
      summary: (summary ?? z.unknown()).optional(),
      asOf: adminIsoDateTimeSchema,
      freshness: adminFreshnessSchema,
      dataQuality: z.array(dataQualityIssueSchema).readonly().optional(),
    })
    .strict();
}

export const adminCursorQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    search: z.string().trim().min(1).max(200).optional(),
    sort: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminCommandReasonSchema = z
  .object({
    code: z.string().trim().min(1),
    summary: z.string().trim().min(1).max(500),
    details: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

export const adminCommandRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    reason: adminCommandReasonSchema,
    approvalId: adminIdSchema.optional(),
    confirmation: z.string().trim().min(1).optional(),
  })
  .strict();

export const adminCommandHeadersSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1),
    ifMatch: z.string().trim().min(1).optional(),
    requestId: adminIdSchema,
  })
  .strict();

export const approvalBindingSchema = z
  .object({
    commandType: z.string().trim().min(1),
    target: adminEntityRefSchema,
    payloadHash: z.string().trim().min(1),
    expectedVersion: z.number().int().nonnegative(),
    expiresAt: adminIsoDateTimeSchema,
  })
  .strict();

export const adminCommandAcceptedSchema = z
  .object({
    status: z.literal("accepted"),
    requestId: adminIdSchema,
    commandId: adminIdSchema,
    verificationDeepLink: z.string().trim().min(1),
  })
  .strict();

export const adminCommandCompletedSchema = z
  .object({
    status: z.literal("completed"),
    requestId: adminIdSchema,
    commandId: adminIdSchema.optional(),
    verificationState: z.literal("passed").optional(),
  })
  .strict();

export const adminCommandResponseSchema = z.discriminatedUnion("status", [
  adminCommandCompletedSchema,
  adminCommandAcceptedSchema,
]);

export const adminCommandStatusSchema = z
  .object({
    commandId: adminIdSchema,
    requestId: adminIdSchema,
    commandType: z.string().trim().min(1),
    target: adminEntityRefSchema,
    status: adminControlPlaneCommandStatusSchema,
    verificationState: adminVerificationStateSchema.optional(),
    needsReconciliation: z.boolean(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict();

export const adminAuditEntrySchema = z
  .object({
    id: adminIdSchema,
    actorId: adminIdSchema,
    actorRole: z.string().trim().min(1),
    action: z.string().trim().min(1),
    targetType: z.string().trim().min(1),
    targetId: adminIdSchema,
    reason: z.string().nullable(),
    before: adminJsonValueSchema.nullable(),
    after: adminJsonValueSchema.nullable(),
    requestId: z.string().nullable(),
    ipHash: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: adminIsoDateTimeSchema,
  })
  .strict();

export type DataQualityIssue = z.infer<typeof dataQualityIssueSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type Blocker = z.infer<typeof blockerSchema>;
export type OperationalStateView = z.infer<typeof operationalStateViewSchema>;
export type AdminCommandRequest = z.infer<typeof adminCommandRequestSchema>;
export type AdminCommandHeaders = z.infer<typeof adminCommandHeadersSchema>;
export type ApprovalBinding = z.infer<typeof approvalBindingSchema>;
export type AdminCommandResponse = z.infer<typeof adminCommandResponseSchema>;
export type AdminCommandStatus = z.infer<typeof adminCommandStatusSchema>;
