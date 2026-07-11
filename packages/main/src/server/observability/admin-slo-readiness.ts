import { availabilityErrorBudget, evaluateAdminOperationalSlos, metricSnapshot } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "@/server/modules/admin-v2/reconciliation/invariants";

function histogramP95UpperBound(series: { count?: number; buckets?: ReadonlyArray<{ le: number; count: number }> }) {
  if (!series.count || !series.buckets) return null;
  const target = Math.ceil(series.count * 0.95);
  const bucket = series.buckets.find((item) => item.count >= target);
  return bucket?.le ?? null;
}

export async function adminSloReadiness(now = new Date()) {
  const snapshot = metricSnapshot();
  const commandMetric = snapshot.find((metric) => metric.name === "admin_command_duration_seconds" && metric.type === "histogram");
  const commandP95s = commandMetric?.series.flatMap((series) => {
    const value = histogramP95UpperBound(series);
    return value === null ? [] : [value];
  }) ?? [];
  const commandCounter = snapshot.find((metric) => metric.name === "admin_command_total" && metric.type === "counter");
  const commandTotal = commandCounter?.series.reduce((sum, series) => sum + (series.value ?? 0), 0) ?? 0;
  const commandFailures = commandCounter?.series.filter((series) => ["error", "conflict"].includes(String(series.labels.outcome))).reduce((sum, series) => sum + (series.value ?? 0), 0) ?? 0;
  const [invariants, oldestOutbox, incidents, metricSnapshots, failedAttempts, unknownAttempts] = await Promise.all([
    auditAdminCutoverInvariants(prisma, now),
    prisma.mainOutboxEvent.findFirst({ where: { status: { in: ["pending", "dispatched"] } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.opsIncident.findMany({ orderBy: { createdAt: "desc" }, take: 1_000, select: { firstSeen: true, createdAt: true } }),
    prisma.metricSnapshot.findMany({ orderBy: { asOf: "desc" }, take: 1, select: { asOf: true } }),
    prisma.generationAttempt.count({ where: { status: { in: ["failed", "unknown"] } } }),
    prisma.generationAttempt.count({ where: { status: { in: ["failed", "unknown"] }, OR: [{ status: "unknown" }, { errorClass: null }, { errorClass: "unknown" }] } }),
  ]);
  const newestMetricAt = metricSnapshots[0]?.asOf ?? null;
  const metricAge = newestMetricAt ? Math.max(0, now.getTime() - newestMetricAt.getTime()) / 1_000 : null;
  const report = evaluateAdminOperationalSlos({
    command_accept_p95: commandP95s.length > 0 ? Math.max(...commandP95s) : null,
    outbox_lag_p95: oldestOutbox ? Math.max(0, now.getTime() - oldestOutbox.createdAt.getTime()) / 1_000 : 0,
    incident_detection_lag: incidents.length > 0 ? Math.max(...incidents.map((incident) => Math.max(0, incident.createdAt.getTime() - incident.firstSeen.getTime()) / 1_000)) : 0,
    operational_health_freshness: metricAge,
    cohort_dashboard_freshness: metricAge,
    state_invariant_violations: invariants.totalViolations,
    generation_unknown_failure_rate: failedAttempts === 0 ? 0 : unknownAttempts / failedAttempts,
  });
  const errorBudget = availabilityErrorBudget({ total: commandTotal, failures: commandFailures });
  return {
    asOf: now.toISOString(),
    status: report.status === "pass" && !errorBudget.exhausted ? "pass" : report.status === "breach" || errorBudget.exhausted ? "breach" : "incomplete",
    decisionUse: report.status === "pass" && !errorBudget.exhausted ? "allowed" : "blocked",
    report,
    errorBudget,
    invariants,
  };
}
