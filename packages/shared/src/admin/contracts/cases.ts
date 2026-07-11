import { z } from "zod";
import {
  adminCursorQuerySchema,
  adminCommandRequestSchema,
  adminEntityRefSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
  adminListResponseSchema,
  adminPrioritySchema,
  adminSeveritySchema,
} from "./common";

export const caseCloseCommandRequestSchema = adminCommandRequestSchema;

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
});

export const operationsCaseListResponseSchema = adminListResponseSchema(operationsCaseSchema);

export type OperationsCase = z.infer<typeof operationsCaseSchema>;
export type CaseEvidence = z.infer<typeof caseEvidenceSchema>;
export type OperationsCaseQuery = z.infer<typeof operationsCaseQuerySchema>;
export type CaseCloseCommandRequest = z.infer<typeof caseCloseCommandRequestSchema>;
