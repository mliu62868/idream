export const ADMIN_OPERATIONAL_SLOS = [
  { key: "list_api_p95", target: 0.5, unit: "seconds", comparison: "lte" },
  { key: "detail_api_p95", target: 0.75, unit: "seconds", comparison: "lte" },
  { key: "today_api_p95", target: 1, unit: "seconds", comparison: "lte" },
  { key: "command_accept_p95", target: 0.75, unit: "seconds", comparison: "lte" },
  { key: "global_search_p95", target: 0.8, unit: "seconds", comparison: "lte" },
  { key: "outbox_lag_p95", target: 60, unit: "seconds", comparison: "lte" },
  { key: "incident_detection_lag", target: 300, unit: "seconds", comparison: "lte" },
  { key: "operational_health_freshness", target: 120, unit: "seconds", comparison: "lte" },
  { key: "cohort_dashboard_freshness", target: 900, unit: "seconds", comparison: "lte" },
  { key: "state_invariant_violations", target: 0, unit: "count", comparison: "lte" },
  { key: "generation_unknown_failure_rate", target: 0.05, unit: "ratio", comparison: "lt" },
] as const;

export type AdminOperationalSloKey = (typeof ADMIN_OPERATIONAL_SLOS)[number]["key"];

export function evaluateAdminOperationalSlos(
  observations: Partial<Record<AdminOperationalSloKey, number | null>>,
) {
  const checks = ADMIN_OPERATIONAL_SLOS.map((definition) => {
    const observed = observations[definition.key];
    const status = observed === undefined || observed === null || !Number.isFinite(observed)
      ? "no_data"
      : definition.comparison === "lt"
        ? observed < definition.target ? "pass" : "breach"
        : observed <= definition.target ? "pass" : "breach";
    return { ...definition, observed: observed ?? null, status };
  });
  return {
    status: checks.some((check) => check.status === "breach") ? "breach" : checks.some((check) => check.status === "no_data") ? "incomplete" : "pass",
    checks,
  };
}

export function availabilityErrorBudget(input: {
  total: number;
  failures: number;
  targetAvailability?: number;
}) {
  const targetAvailability = input.targetAvailability ?? 0.99;
  if (!Number.isInteger(input.total) || !Number.isInteger(input.failures) || input.total < 0 || input.failures < 0 || input.failures > input.total) throw new Error("Invalid error-budget counts");
  const allowedFailures = input.total * (1 - targetAvailability);
  const remaining = allowedFailures - input.failures;
  return {
    targetAvailability,
    total: input.total,
    failures: input.failures,
    allowedFailures,
    remaining,
    remainingRatio: allowedFailures === 0 ? (input.failures === 0 ? 1 : 0) : Math.max(0, remaining / allowedFailures),
    exhausted: remaining < 0,
  };
}
