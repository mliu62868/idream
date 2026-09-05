import { describe, expect, it } from "vitest";
import { caseDecisionRequestSchema, customerCaseActionRequestSchema } from "./cases";

describe("typed Case command contracts", () => {
  it("accepts only Review Case decisions on the decision endpoint", () => {
    const input = {
      entityVersion: 2,
      decision: "actioned",
      summary: "Reviewed the immutable evidence and applied the downstream action.",
      evidenceRefs: ["evidence-1"],
    };
    expect(caseDecisionRequestSchema.safeParse(input).success).toBe(true);
    expect(caseDecisionRequestSchema.safeParse({ ...input, decision: "restore_access" }).success).toBe(false);
    expect(caseDecisionRequestSchema.safeParse({ ...input, decision: "diagnostic_reviewed" }).success).toBe(false);
  });

  it("accepts only typed Support/Billing actions on the action endpoint", () => {
    const input = {
      entityVersion: 2,
      action: "account_guidance_provided",
      summary: "Provided guidance and captured the downstream entitlement reference.",
      evidenceRefs: ["evidence-1"],
      outcomeRef: "guidance:user-1",
    };
    expect(customerCaseActionRequestSchema.safeParse(input).success).toBe(true);
    expect(customerCaseActionRequestSchema.safeParse({ ...input, action: "actioned" }).success).toBe(false);
    expect(customerCaseActionRequestSchema.safeParse({ ...input, action: "restore_access" }).success).toBe(false);
  });
});
