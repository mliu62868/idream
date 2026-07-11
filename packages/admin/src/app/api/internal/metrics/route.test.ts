import { afterEach, describe, expect, it } from "vitest";
import { incrementCounter, resetMetricsForTests } from "@idream/shared";
import { GET } from "./route";

const previousToken = process.env.INTERNAL_TOKEN;

afterEach(() => {
  resetMetricsForTests();
  if (previousToken === undefined) delete process.env.INTERNAL_TOKEN;
  else process.env.INTERNAL_TOKEN = previousToken;
});

describe("Admin metrics exporter", () => {
  it("requires the internal token and renders Prometheus text", async () => {
    process.env.INTERNAL_TOKEN = "metrics-test-token";
    expect((await GET(new Request("http://admin.local/api/internal/metrics"))).status).toBe(401);
    incrementCounter("admin_http_requests_total", "Admin requests", { method: "GET" });
    const response = await GET(new Request("http://admin.local/api/internal/metrics", {
      headers: { "x-internal-token": "metrics-test-token" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toContain("admin_http_requests_total");
  });
});
