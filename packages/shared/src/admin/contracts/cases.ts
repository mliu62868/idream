import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminAuditEntrySchema,
  adminCommandRequestSchema,
  adminEntityRefSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPrioritySchema,
  adminSeveritySchema,
  adminJsonValueSchema,
} from "./common";

export const caseCloseCommandRequestSchema = adminCommandRequestSchema;

export const caseAssignmentRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    ownerId: adminIdSchema.nullable(),
    priority: adminPrioritySchema.optional(),
    slaDueAt: adminIsoDateTimeSchema.optional(),
    reason: z.string().trim().min(1),
  })
  .strict();

export const caseReopenRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(2_000),
    confirmation: z.string().trim().min(1),
  })
  .strict();

export const caseWaitRequestSchema = z
  .object({
    entityVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(2_000),
    resumeAt: adminIsoDateTimeSchema.optional(),
    confirmation: z.string().trim().min(1),
  })
  .strict();

export const CONTENT_REPORT_CASE_DECISIONS = [
  "actioned",
  "no_violation",
  "duplicate",
  "escalated",
  "closed",
] as const;
export const APPEAL_CASE_DECISIONS = ["upheld", "overturned", "modified", "open"] as const;
export const REVIEW_CASE_DECISIONS = [
  ...CONTENT_REPORT_CASE_DECISIONS,
  ...APPEAL_CASE_DECISIONS,
] as const;
export const SUPPORT_CASE_ACTIONS = [
  "diagnostic_reviewed",
  "reply_requested",
  "incident_escalated",
  "account_guidance_provided",
] as const;
export const BILLING_CASE_ACTIONS = [
  "ledger_reconciled",
  "refund_requested",
  "subscription_corrected",
] as const;

export const caseDecisionRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    decision: z.enum(REVIEW_CASE_DECISIONS),
    summary: z.string().trim().min(1).max(4_000),
    evidenceRefs: z.array(adminIdSchema).min(1),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const caseVerificationRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    state: z.enum(["passed", "failed", "overridden"]),
    evidenceRefs: z.array(adminIdSchema).min(1),
    overrideReason: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "overridden" && !value.overrideReason) {
      ctx.addIssue({ code: "custom", path: ["overrideReason"], message: "Override reason is required" });
    }
  });

export const customerCaseActionRequestSchema = z
  .object({
    entityVersion: z.number().int().nonnegative(),
    action: z.enum([...SUPPORT_CASE_ACTIONS, ...BILLING_CASE_ACTIONS]),
    summary: z.string().trim().min(1).max(4_000),
    evidenceRefs: z.array(adminIdSchema).min(1),
    outcomeRef: z.string().trim().min(1).max(500),
  })
  .strict();

export const operationsCaseTypeSchema = z.enum([
  "support_request",
  "content_report",
  "appeal",
  "billing_dispute",
]);
export const operationsCaseStatusSchema = z.enum([
  "new",
  "triaged",
  "in_progress",
  "waiting",
  "resolved",
  "closed",
  "reopened",
]);

export const caseVerificationSchema = z
  .object({
    state: z.enum(["pending", "verifying", "passed", "failed", "overridden"]),
    evidenceRefs: z.array(z.string().trim().min(1)).min(1).readonly(),
    verifiedAt: adminIsoDateTimeSchema.nullable(),
    overrideReason: z.string().trim().min(1).nullable(),
  })
  .strict();

export const operationsCaseSchema = z
  .object({
    id: adminIdSchema,
    type: operationsCaseTypeSchema,
    target: adminEntityRefSchema,
    caseKey: z.string().trim().min(1),
    status: operationsCaseStatusSchema,
    priority: adminPrioritySchema,
    severity: adminSeveritySchema,
    ownerId: adminIdSchema.nullable(),
    slaDueAt: adminIsoDateTimeSchema,
    reportCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    resolutionSummary: z.string().trim().min(1).nullable(),
    verification: caseVerificationSchema.nullable(),
    relatedIncidentIds: z.array(adminIdSchema).readonly(),
    relatedCaseIds: z.array(adminIdSchema).readonly(),
    version: z.number().int().nonnegative(),
    createdAt: adminIsoDateTimeSchema,
    updatedAt: adminIsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (["resolved", "closed"].includes(value.status)) {
      if (value.resolutionSummary === null) {
        ctx.addIssue({ code: "custom", path: ["resolutionSummary"], message: "Resolution is required" });
      }
      if (value.verification === null) {
        ctx.addIssue({ code: "custom", path: ["verification"], message: "Verification is required" });
      }
    }
  });

export const caseEvidenceSchema = z
  .object({
    id: adminIdSchema,
    caseId: adminIdSchema,
    source: adminEntityRefSchema,
    evidenceType: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    occurredAt: adminIsoDateTimeSchema,
    access: z.enum(["full", "redacted"]),
  })
  .strict();

export const operationsCaseQuerySchema = adminCursorQuerySchema.extend({
  view: z.enum(["mine", "unassigned", "overdue", "appeals", "recently_resolved", "all"]).default("mine"),
  type: operationsCaseTypeSchema.optional(),
  status: operationsCaseStatusSchema.optional(),
  ownerId: adminIdSchema.optional(),
  priority: adminPrioritySchema.optional(),
  sort: z.enum(["updated_desc", "updated_asc"]).default("updated_desc"),
});

export const operationsCaseListResponseSchema = adminListResponseSchema(operationsCaseSchema).extend({
  query: operationsCaseQuerySchema.extend({ cursor: z.string().nullable() }),
});

export const caseDecisionRecordSchema = z.object({
  id: adminIdSchema,
  sourceType: z.string().trim().min(1),
  sourceId: adminIdSchema,
  releaseId: adminIdSchema.nullable(),
  question: z.string().trim().min(1),
  evidenceRefs: adminJsonValueSchema,
  evidenceLevel: z.string().trim().min(1),
  decision: z.string().trim().min(1),
  confidence: z.number().nullable(),
  ownerId: adminIdSchema,
  successCriteria: adminJsonValueSchema,
  guardrails: adminJsonValueSchema,
  reviewAt: adminIsoDateTimeSchema.nullable(),
  outcome: adminJsonValueSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const operationsCaseDetailSchema = z.object({
  case: operationsCaseSchema,
  evidence: z.array(caseEvidenceSchema).readonly(),
  decisions: z.array(caseDecisionRecordSchema).readonly(),
  activity: z.array(adminAuditEntrySchema).readonly(),
}).strict();

export type OperationsCase = z.infer<typeof operationsCaseSchema>;
export type CaseEvidence = z.infer<typeof caseEvidenceSchema>;
export type OperationsCaseQuery = z.infer<typeof operationsCaseQuerySchema>;
export type CaseCloseCommandRequest = z.infer<typeof caseCloseCommandRequestSchema>;
export type CaseAssignmentRequest = z.infer<typeof caseAssignmentRequestSchema>;
export type CaseDecisionRequest = z.infer<typeof caseDecisionRequestSchema>;
export type CaseVerificationRequest = z.infer<typeof caseVerificationRequestSchema>;
export type CustomerCaseActionRequest = z.infer<typeof customerCaseActionRequestSchema>;
