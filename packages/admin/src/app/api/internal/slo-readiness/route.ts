import { availabilityErrorBudget, evaluateAdminOperationalSlos, metricSnapshot } from "@idream/shared";

function p95Upper(series: { count?: number; buckets?: ReadonlyArray<{ le: number; count: number }> }) {
  if (!series.count || !series.buckets) return null;
  const target = Math.ceil(series.count * 0.95);
  return series.buckets.find((bucket) => bucket.count >= target)?.le ?? null;
}

export async function GET(request: Request) {
  const expected = process.env.INTERNAL_TOKEN;
  if (!expected || request.headers.get("x-internal-token") !== expected) return Response.json({ error: "unauthorized" }, { status: 401 });
  const snapshot = metricSnapshot();
  const duration = snapshot.find((metric) => metric.name === "admin_http_request_duration_seconds" && metric.type === "histogram");
  const p95 = (routeClass: string) => {
    const values = duration?.series.filter((series) => series.labels.surface === "admin_v2" && series.labels.routeClass === routeClass).flatMap((series) => {
      const value = p95Upper(series);
      return value === null ? [] : [value];
    }) ?? [];
    return values.length > 0 ? Math.max(...values) : null;
  };
  const counters = snapshot.find((metric) => metric.name === "admin_http_requests_total" && metric.type === "counter")?.series.filter((series) => series.labels.surface === "admin_v2") ?? [];
  const total = counters.reduce((sum, series) => sum + (series.value ?? 0), 0);
  const failures = counters.filter((series) => ["unavailable", "configuration_error", "upstream_error"].includes(String(series.labels.outcome))).reduce((sum, series) => sum + (series.value ?? 0), 0);
  const report = evaluateAdminOperationalSlos({ list_api_p95: p95("list"), detail_api_p95: p95("detail"), today_api_p95: p95("today"), command_accept_p95: p95("command"), global_search_p95: p95("search") });
  const errorBudget = availabilityErrorBudget({ total, failures });
  return Response.json({ asOf: new Date().toISOString(), status: report.status === "pass" && !errorBudget.exhausted ? "pass" : report.status === "breach" || errorBudget.exhausted ? "breach" : "incomplete", decisionUse: report.status === "pass" && !errorBudget.exhausted ? "allowed" : "blocked", report, errorBudget });
}
