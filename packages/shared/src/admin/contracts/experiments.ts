import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

export const experimentVariantSchema = z.object({
  key: z.string().trim().min(1).max(64),
  allocationBps: z.number().int().positive().max(10_000),
}).strict();

export const experimentGuardrailSchema = z.object({
  metricKey: z.string().trim().min(1).max(128),
  maxAbsoluteRegression: z.number().min(0).max(1),
}).strict();

export const experimentMetricsSchema = z.object({
  primary: z.literal("relationship.qce_activation.v1"),
  controlVariant: z.string().trim().min(1).max(64),
  minimumMaturePerArm: z.number().int().min(20).max(1_000_000).default(100),
  guardrails: z.array(experimentGuardrailSchema).min(1),
}).strict();

export const experimentDefinitionCreateSchema = z.object({
  key: z.string().trim().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/),
  hypothesis: z.string().trim().min(10).max(1_000),
  eligibility: z.record(z.string(), z.unknown()),
  variants: z.array(experimentVariantSchema).min(2).max(10),
  salt: z.string().min(16).max(256),
  metrics: experimentMetricsSchema,
}).strict().superRefine((value, ctx) => {
  const keys = new Set(value.variants.map((variant) => variant.key));
  if (keys.size !== value.variants.length) ctx.addIssue({ code: "custom", path: ["variants"], message: "Variant keys must be unique" });
  if (value.variants.reduce((sum, variant) => sum + variant.allocationBps, 0) !== 10_000) ctx.addIssue({ code: "custom", path: ["variants"], message: "Allocations must total 10000 bps" });
  if (!keys.has(value.metrics.controlVariant)) ctx.addIssue({ code: "custom", path: ["metrics", "controlVariant"], message: "Control variant must exist" });
});

export const experimentLifecycleRequestSchema = z.object({
  expectedStateVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
}).strict();

export const experimentStatusSchema = z.enum(["draft", "running", "stopped"]);

export const experimentDefinitionSchema = z.object({
  id: adminIdSchema,
  key: z.string().min(1),
  version: z.number().int().positive(),
  hypothesis: z.string().min(1),
  eligibility: z.record(z.string(), z.unknown()),
  variants: z.array(experimentVariantSchema),
  metrics: experimentMetricsSchema,
  status: experimentStatusSchema,
  stateVersion: z.number().int().positive(),
  startedAt: adminIsoDateTimeSchema.nullable(),
  stoppedAt: adminIsoDateTimeSchema.nullable(),
  createdAt: adminIsoDateTimeSchema,
  updatedAt: adminIsoDateTimeSchema,
}).strict();

export const experimentAnalysisQuerySchema = z.object({
  asOf: adminIsoDateTimeSchema.optional(),
}).strict();

export const experimentDefinitionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: experimentStatusSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  cursor: adminIdSchema.optional(),
}).strict();

export const experimentDefinitionListSchema = z.object({
  items: z.array(experimentDefinitionSchema).readonly(),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: adminIdSchema.nullable(),
  }).strict(),
  asOf: adminIsoDateTimeSchema,
}).strict();

export const experimentAssignmentRequestSchema = z.object({
  subjectType: z.enum(["user", "anonymous"]),
  subjectId: adminIdSchema,
  eligibilitySnapshot: z.record(z.string(), z.unknown()),
  version: z.number().int().positive().optional(),
}).strict();

export const experimentAssignmentResponseSchema = z.object({
  status: z.enum(["assigned", "ineligible"]),
  experimentId: adminIdSchema,
  experimentKey: z.string().min(1),
  experimentVersion: z.number().int().positive(),
  assignmentId: adminIdSchema.nullable(),
  assignmentVersion: z.string().min(1),
  variant: z.string().min(1).nullable(),
  assignedAt: adminIsoDateTimeSchema.nullable(),
}).strict();

export const experimentExposureRequestSchema = z.object({
  exposureId: adminIdSchema,
  assignmentId: adminIdSchema,
  surface: z.string().trim().min(1).max(128),
  occurredAt: adminIsoDateTimeSchema,
}).strict();

export const experimentExposureResponseSchema = z.object({
  status: z.enum(["recorded", "duplicate"]),
  exposureId: adminIdSchema,
  assignmentId: adminIdSchema,
  experimentId: adminIdSchema,
  experimentVersion: z.number().int().positive(),
  assignmentVersion: z.string().min(1),
  variant: z.string().min(1),
}).strict();

export const experimentArmAnalysisSchema = z.object({
  variant: z.string().min(1),
  assignedSubjects: z.number().int().nonnegative(),
  exposedSubjects: z.number().int().nonnegative(),
  matureSubjects: z.number().int().nonnegative(),
  outcomeSubjects: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1).nullable(),
  absoluteLiftVsControl: z.number().min(-1).max(1).nullable(),
  confidenceInterval95: z.tuple([z.number(), z.number()]).nullable(),
  pValueVsControl: z.number().min(0).max(1).nullable(),
}).strict();

export const experimentGuardrailAnalysisSchema = z.object({
  metricKey: z.string().min(1),
  maxAbsoluteRegression: z.number().min(0).max(1),
  controlRate: z.number().min(0).max(1).nullable(),
  worstVariantRate: z.number().min(0).max(1).nullable(),
  observedRegression: z.number().min(-1).max(1).nullable(),
  state: z.enum(["passed", "failed", "blocked"]),
  evidence: z.array(z.string().min(1)).readonly(),
}).strict();

export const experimentAnalysisResponseSchema = z.object({
  experimentId: adminIdSchema,
  experimentKey: z.string().min(1),
  experimentVersion: z.number().int().positive(),
  status: z.string().min(1),
  primaryMetric: z.literal("relationship.qce_activation.v1"),
  controlVariant: z.string().min(1),
  window: z.literal("7d_after_first_exposure"),
  asOf: adminIsoDateTimeSchema,
  maturity: z.enum(["mature", "immature", "insufficient_data"]),
  qualityState: z.enum(["certified", "directional", "invalid"]),
  decisionUse: z.enum(["eligible", "directional_only", "blocked"]),
  significance: z.enum(["significant", "not_significant", "unavailable"]),
  guardrailState: z.enum(["passed", "failed", "blocked"]),
  guardrails: z.array(experimentGuardrailAnalysisSchema).min(1).readonly(),
  minimumMaturePerArm: z.number().int().positive(),
  qualityEvidence: z.array(z.string()),
  arms: z.array(experimentArmAnalysisSchema),
}).strict();

export type ExperimentVariant = z.infer<typeof experimentVariantSchema>;
export type ExperimentDefinition = z.infer<typeof experimentDefinitionSchema>;
export type ExperimentAnalysisQuery = z.infer<typeof experimentAnalysisQuerySchema>;
export type ExperimentAssignmentRequest = z.infer<typeof experimentAssignmentRequestSchema>;
export type ExperimentAssignmentResponse = z.infer<typeof experimentAssignmentResponseSchema>;
export type ExperimentExposureRequest = z.infer<typeof experimentExposureRequestSchema>;
export type ExperimentExposureResponse = z.infer<typeof experimentExposureResponseSchema>;
export type ExperimentArmAnalysis = z.infer<typeof experimentArmAnalysisSchema>;
export type ExperimentAnalysisResponse = z.infer<typeof experimentAnalysisResponseSchema>;
