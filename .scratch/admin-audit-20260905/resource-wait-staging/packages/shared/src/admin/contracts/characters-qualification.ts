// SPEC: Generation route qualification — evaluating a route matrix into a
// candidate/qualified/paused/expired verdict.

import { z } from "zod";
import {
  adminCommandReasonSchema,
  adminIdSchema,
  adminIsoDateTimeSchema,
} from "./common";

export const generationRouteQualificationResultSchema = z.enum(["candidate", "qualified", "paused", "expired"]);

export const generationRouteQualificationEvaluateRequestSchema = z
  .object({
    batchIds: z.array(adminIdSchema).min(1).max(20),
    matrixKey: z.string().trim().min(1).max(160),
    style: z.enum(["realistic", "anime", "hybrid", "other"]),
    policyVersion: z.string().trim().min(1).max(160),
    costLatencyGuardrail: z
      .object({
        status: z.enum(["passed", "failed"]),
        evidenceRef: z.string().trim().min(1).max(500),
      })
      .strict(),
    expiresAt: adminIsoDateTimeSchema.nullable(),
    reason: adminCommandReasonSchema,
    confirmation: z.string().trim().min(1).max(240),
  })
  .strict();

export const generationRouteQualificationEvaluateResponseSchema = z
  .object({
    qualificationId: adminIdSchema,
    routeFingerprint: z.string().trim().min(1),
    result: z.enum(["candidate", "qualified"]),
    sampleCount: z.number().int().nonnegative(),
    passCount: z.number().int().nonnegative(),
    identityMatch: z.number().min(0).max(1),
    evaluatorVersion: z.string().trim().min(1),
    evidenceHash: z.string().trim().min(1),
    replayed: z.boolean(),
  })
  .strict();
