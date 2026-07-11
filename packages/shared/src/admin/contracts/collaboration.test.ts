import { describe, expect, it } from "vitest";
import { experimentDefinitionCreateSchema, savedViewQueryStateSchema } from "./index";

describe("admin collaboration and experiment contracts", () => {
  it("rejects unbounded or client-only saved view query state", () => {
    expect(savedViewQueryStateSchema.safeParse({ search: "", filters: {}, sort: { field: "updatedAt", direction: "desc" }, pageSize: 201 }).success).toBe(false);
    expect(savedViewQueryStateSchema.safeParse({ search: "", filters: {}, sort: { field: "updatedAt", direction: "desc" }, pageSize: 50, cursor: "client-row" }).success).toBe(false);
  });

  it("requires balanced immutable experiment variants and a real guardrail", () => {
    const base = {
      key: "onboarding.copy",
      hypothesis: "A shorter opening increases qualified engagement",
      eligibility: {},
      variants: [{ key: "control", allocationBps: 5_000 }, { key: "treatment", allocationBps: 5_000 }],
      salt: "0123456789abcdef",
      metrics: { primary: "relationship.qce_activation.v1", controlVariant: "control", minimumMaturePerArm: 100, guardrails: [{ metricKey: "guardrail.support_contact_rate.v1", maxAbsoluteRegression: 0.02 }] },
    };
    expect(experimentDefinitionCreateSchema.safeParse(base).success).toBe(true);
    expect(experimentDefinitionCreateSchema.safeParse({ ...base, variants: [{ key: "control", allocationBps: 9_000 }, { key: "treatment", allocationBps: 500 }] }).success).toBe(false);
    expect(experimentDefinitionCreateSchema.safeParse({ ...base, metrics: { ...base.metrics, guardrails: [] } }).success).toBe(false);
  });
});
