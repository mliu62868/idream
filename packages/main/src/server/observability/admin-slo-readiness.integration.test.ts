import { describe, expect, it } from "vitest";
import { incrementCounter, observeHistogram, resetMetricsForTests } from "@idream/shared";
import { adminSloReadiness } from "./admin-slo-readiness";

describe("Admin SLO readiness", () => {
  it("keeps missing surface evidence explicit and blocks incomplete launch decisions", async () => {
    resetMetricsForTests();
    incrementCounter("admin_command_total", "commands", { type: "test", outcome: "accepted" }, 100);
    observeHistogram("admin_command_duration_seconds", "duration", { type: "test", outcome: "accepted" }, 0.2);
    const report = await adminSloReadiness(new Date());
    expect(report.report.checks.find((check) => check.key === "command_accept_p95")).toMatchObject({ status: "pass" });
    expect(report.report.checks.find((check) => check.key === "list_api_p95")).toMatchObject({ status: "no_data" });
    expect(report.decisionUse).toBe("blocked");
    resetMetricsForTests();
  });
});
