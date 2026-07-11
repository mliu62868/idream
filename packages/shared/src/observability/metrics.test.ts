import { afterEach, describe, expect, it } from "vitest";
import {
  incrementCounter,
  observeHistogram,
  renderPrometheusMetrics,
  resetMetricsForTests,
  setGauge,
} from "./metrics";

afterEach(resetMetricsForTests);

describe("process metrics registry", () => {
  it("renders deterministic low-cardinality counters, gauges, and histograms", () => {
    incrementCounter("admin_http_requests_total", "Admin requests", { method: "GET", outcome: "ok" });
    incrementCounter("admin_http_requests_total", "Admin requests", { outcome: "ok", method: "GET" }, 2);
    setGauge("main_outbox_pending_age_seconds", "Oldest pending outbox row", {}, 12);
    observeHistogram("admin_http_request_duration_seconds", "Admin request latency", { method: "GET" }, 0.08, [0.05, 0.1]);

    const rendered = renderPrometheusMetrics();
    expect(rendered).toContain('admin_http_requests_total{method="GET",outcome="ok"} 3');
    expect(rendered).toContain("main_outbox_pending_age_seconds 12");
    expect(rendered).toContain('admin_http_request_duration_seconds_bucket{le="0.05",method="GET"} 0');
    expect(rendered).toContain('admin_http_request_duration_seconds_bucket{le="0.1",method="GET"} 1');
    expect(rendered).toContain('admin_http_request_duration_seconds_count{method="GET"} 1');
  });

  it("rejects negative counters and invalid metric names", () => {
    expect(() => incrementCounter("bad-name", "bad")).toThrow("Invalid metric name");
    expect(() => incrementCounter("valid_total", "valid", {}, -1)).toThrow("non-negative");
  });
});
