import { describe, expect, it } from "vitest";
import { evaluateCanonicalMetrics } from "./engine";
import { METRIC_FORMULA_VALIDATION, validateCanonicalMetricFormulae } from "./formula-validation";

describe("independent metric formula certification", () => {
  it("checks all thirteen cohort formulae against hand-calculated inputs, boundaries and exclusions", () => {
    expect(new Set(METRIC_FORMULA_VALIDATION.checks.map((check) => check.metricKey)).size).toBe(13);
    expect(METRIC_FORMULA_VALIDATION.checks.filter((check) => !check.passed)).toEqual([]);
  });

  it("records evaluator exceptions as failed evidence instead of breaking metric reads", () => {
    const result = validateCanonicalMetricFormulae(() => { throw new Error("formula regression"); });
    expect(result.checks.every((check) => !check.passed && check.error === "formula regression")).toBe(true);
  });

  it("rejects a plausible, finite but wrong formula even though its numerator fits the cohort", () => {
    const changed = validateCanonicalMetricFormulae((dataset, asOf) => {
      const result = evaluateCanonicalMetrics(dataset, asOf);
      return { ...result, metrics: { ...result.metrics, "north_star.wpcu": {
        ...result.metrics["north_star.wpcu"], numerator: 0, value: 0,
      } } };
    });
    expect(changed.checks.some((check) => check.metricKey === "north_star.wpcu" && !check.passed)).toBe(true);
    expect(changed.inputHash).toBe(METRIC_FORMULA_VALIDATION.inputHash);
    expect(changed.evidenceHash).not.toBe(METRIC_FORMULA_VALIDATION.evidenceHash);
  });

  it("detects changing exact-day retention into any-day return", () => {
    const changed = validateCanonicalMetricFormulae((dataset, asOf) => {
      const result = evaluateCanonicalMetrics(dataset, asOf);
      const d1 = result.metrics["retention.same_character_d1"];
      return { ...result, metrics: { ...result.metrics, "retention.same_character_d1": {
        ...d1, numerator: d1.denominator ?? 0, value: d1.denominator ? 1 : null,
      } } };
    });
    expect(changed.checks.some((check) => check.metricKey === "retention.same_character_d1" && !check.passed)).toBe(true);
  });
});
