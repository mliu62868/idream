import { describe, expect, it } from "vitest";
import { generationRouteQualificationEvaluateRequestSchema } from "./characters";

const validRequest = {
  batchIds: ["eval-batch-1", "eval-batch-2"],
  matrixKey: "realistic-default-v1",
  style: "realistic" as const,
  policyVersion: "character-release-v2",
  costLatencyGuardrail: { status: "passed" as const, evidenceRef: "eval-report://route-1" },
  expiresAt: null,
  reason: { code: "route_eval_complete", summary: "Publish computed route evidence." },
  confirmation: "QUALIFY realistic-default-v1",
};

describe("Generation route qualification contract", () => {
  it("accepts evidence references but never a client-authored score or result", () => {
    expect(generationRouteQualificationEvaluateRequestSchema.parse(validRequest)).toEqual(validRequest);
    expect(generationRouteQualificationEvaluateRequestSchema.safeParse({
      ...validRequest,
      identityMatch: 0.99,
      result: "qualified",
    }).success).toBe(false);
  });

  it("requires a cost/latency guardrail verdict and bounded matrix identity", () => {
    const { costLatencyGuardrail: _guardrail, ...missingGuardrail } = validRequest;
    expect(generationRouteQualificationEvaluateRequestSchema.safeParse(missingGuardrail).success).toBe(false);
    expect(generationRouteQualificationEvaluateRequestSchema.safeParse({
      ...validRequest,
      matrixKey: "",
    }).success).toBe(false);
  });
});
