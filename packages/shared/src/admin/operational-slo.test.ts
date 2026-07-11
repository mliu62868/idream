import { describe, expect, it } from "vitest";
import { availabilityErrorBudget, evaluateAdminOperationalSlos } from "./operational-slo";

describe("Admin operational SLOs", () => {
  it("fails closed on breaches and keeps missing evidence explicit", () => {
    const report = evaluateAdminOperationalSlos({ list_api_p95: 0.4, state_invariant_violations: 1 });
    expect(report.status).toBe("breach");
    expect(report.checks.find((check) => check.key === "list_api_p95")?.status).toBe("pass");
    expect(report.checks.find((check) => check.key === "detail_api_p95")?.status).toBe("no_data");
  });

  it("computes a finite rolling availability error budget", () => {
    expect(availabilityErrorBudget({ total: 10_000, failures: 20 })).toMatchObject({ allowedFailures: expect.closeTo(100), remaining: expect.closeTo(80), exhausted: false });
    expect(availabilityErrorBudget({ total: 1_000, failures: 20 }).exhausted).toBe(true);
  });
});
