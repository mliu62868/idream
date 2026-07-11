import { z } from "zod";
import { adminIsoDateTimeSchema } from "./common";

export const adminInvariantCheckSchema = z.object({
  key: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(["passed", "failed", "unavailable"]),
  violationCount: z.number().int().nonnegative().nullable(),
  sampleIds: z.array(z.string().min(1)),
  evidence: z.string().min(1),
}).strict();

export const adminInvariantReportSchema = z.object({
  asOf: adminIsoDateTimeSchema,
  qualityState: z.enum(["certified", "invalid"]),
  decisionUse: z.enum(["allowed", "blocked"]),
  totalViolations: z.number().int().nonnegative(),
  unavailableChecks: z.number().int().nonnegative(),
  checks: z.array(adminInvariantCheckSchema),
}).strict();

export type AdminInvariantCheck = z.infer<typeof adminInvariantCheckSchema>;
export type AdminInvariantReport = z.infer<typeof adminInvariantReportSchema>;
