import { z } from "zod";
import { adminIdSchema, adminIsoDateTimeSchema } from "./common";

export const experimentVariantSchema = z.object({
  key: z.string().trim().min(1).max(64),
  allocationBps: z.number().int().positive().max(10_000),
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
  qualityState: z.enum(["directional", "invalid"]),
  decisionUse: z.enum(["directional_only", "blocked"]),
  qualityEvidence: z.array(z.string()),
  arms: z.array(experimentArmAnalysisSchema),
}).strict();

export type ExperimentVariant = z.infer<typeof experimentVariantSchema>;
export type ExperimentAssignmentRequest = z.infer<typeof experimentAssignmentRequestSchema>;
export type ExperimentAssignmentResponse = z.infer<typeof experimentAssignmentResponseSchema>;
export type ExperimentExposureRequest = z.infer<typeof experimentExposureRequestSchema>;
export type ExperimentExposureResponse = z.infer<typeof experimentExposureResponseSchema>;
export type ExperimentArmAnalysis = z.infer<typeof experimentArmAnalysisSchema>;
export type ExperimentAnalysisResponse = z.infer<typeof experimentAnalysisResponseSchema>;
