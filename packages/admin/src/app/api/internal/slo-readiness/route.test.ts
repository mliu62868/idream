import { afterEach, describe, expect, it } from "vitest";
import { observeHistogram, resetMetricsForTests } from "@idream/shared";
import { GET } from "./route";

afterEach(() => {
  delete process.env.INTERNAL_TOKEN;
  resetMetricsForTests();
});

describe("Admin SLO readiness route", () => {
  it("reports observed surface p95 and blocks missing launch evidence", async () => {
    process.env.INTERNAL_TOKEN = "slo-readiness-token";
    observeHistogram("admin_http_request_duration_seconds", "duration", { method: "GET", outcome: "completed", routeClass: "list", surface: "admin_v2" }, 0.2);
    const response = await GET(new Request("http://admin.local/api/internal/slo-readiness", { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.report.checks.find((check: { key: string }) => check.key === "list_api_p95").status).toBe("pass");
    expect(payload.decisionUse).toBe("blocked");
  });
});
