import { canonicalSha256 } from "../shared/canonical-json";
import { evaluateCanonicalMetrics, type CanonicalMetricDataset, type CanonicalMetricEvaluation } from "./engine";

// SPEC: Hand-calculated counterexamples are formula evidence, never customer facts.
// Keep expected answers independent of the evaluator and persist their input/output hashes.
const empty = (): CanonicalMetricDataset => ({ signups: [], chatExchanges: [], generationDeliveries: [], subscriptions: [] });
const at = (value: string) => new Date(value);
function episode(userId: string, session: string, date: string, count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    exchangeId: `${userId}:${session}:${index}`, userId, characterId: `${userId}-character`,
    engagementSessionId: session, occurredAt: new Date(at(date).getTime() + index * 1_000), eligible: true,
  }));
}
const cohort: CanonicalMetricDataset = {
  signups: [
    { userId: "one", occurredAt: at("2026-06-01T00:00:00Z"), eligible: true },
    { userId: "two", occurredAt: at("2026-06-01T00:00:00Z"), eligible: true },
    { userId: "recent", occurredAt: at("2026-06-16T00:00:00Z"), eligible: true },
    { userId: "internal", occurredAt: at("2026-06-01T00:00:00Z"), eligible: false },
  ],
  chatExchanges: [
    ...episode("one", "d0", "2026-06-01T08:00:00Z"),
    ...episode("one", "d1", "2026-06-02T08:01:00Z"),
    ...episode("one", "d7", "2026-06-08T09:00:00Z"),
    ...episode("two", "d0", "2026-06-01T10:00:00Z"),
    ...episode("two", "d2", "2026-06-03T10:00:00Z"),
    ...episode("recent", "d0", "2026-06-16T01:00:00Z"),
  ],
  generationDeliveries: [{ requestId: "generation-two", userId: "two", occurredAt: at("2026-06-04T00:00:00Z"), eligible: true }],
  subscriptions: [
    { subscriptionId: "sub-one", userId: "one", activeAt: at("2026-06-05T00:00:00Z"), endedAt: null, eligible: true },
    { subscriptionId: "sub-two", userId: "two", activeAt: at("2026-06-11T00:00:00Z"), endedAt: null, eligible: true },
  ],
};
const weekly: CanonicalMetricDataset = {
  ...empty(),
  chatExchanges: [
    ...episode("companion", "a", "2026-07-14T08:00:00Z"),
    ...episode("companion", "b", "2026-07-15T08:01:00Z"),
    ...episode("too-close", "a", "2026-07-14T23:00:00Z"),
    ...episode("too-close", "b", "2026-07-15T01:00:00Z"),
    ...episode("four-only", "a", "2026-07-14T08:00:00Z", 4),
    ...episode("previous-week", "a", "2026-07-12T23:59:00Z", 1),
    ...episode("at-asof", "a", "2026-07-19T23:59:59Z", 1),
    ...episode("internal", "a", "2026-07-14T08:00:00Z").map((row) => ({ ...row, eligible: false })),
    // Replayed logical exchanges must not turn four exchanges into a QCE.
    ...episode("four-only", "a", "2026-07-14T08:00:00Z", 4),
  ],
  generationDeliveries: [
    { requestId: "first", userId: "creator", occurredAt: at("2026-07-14T01:00:00Z"), eligible: true },
    { requestId: "second", userId: "creator", occurredAt: at("2026-07-15T14:00:00Z"), eligible: true },
    { requestId: "second", userId: "creator", occurredAt: at("2026-07-15T14:00:00Z"), eligible: true },
  ],
  subscriptions: ["companion", "creator", "previous-week", "at-asof", "internal"].map((userId) => ({
    subscriptionId: `sub-${userId}`, userId, activeAt: at("2026-07-01T00:00:00Z"), endedAt: null, eligible: true,
  })),
};

type Expected = { numerator: number; denominator: number | null; value: number | null; matureSampleSize: number; immatureSampleSize: number };
const count = (numerator: number, sample: number): Expected => ({ numerator, denominator: null, value: numerator, matureSampleSize: sample, immatureSampleSize: 0 });
const rate = (numerator: number, denominator: number, immature: number): Expected => ({ numerator, denominator, value: denominator === 0 ? null : numerator / denominator, matureSampleSize: denominator, immatureSampleSize: immature });
const cases: ReadonlyArray<{ key: string; dataset: CanonicalMetricDataset; asOf: Date; expected: Record<string, Expected> }> = [
  {
    key: "mature-cohort-exact-retention-and-immature-exclusion", dataset: cohort, asOf: at("2026-06-16T12:00:00Z"),
    expected: {
      "north_star.wpcu": count(0, 1), "north_star.wscu": count(0, 1), "diagnostic.wsr": count(0, 1),
      "guardrail.wscru": count(0, 0), "business.wpscu": count(0, 0),
      "activation.chat_24h": rate(2, 2, 1), "activation.relationship_7d": rate(2, 2, 1),
      "activation.generation_7d": rate(1, 2, 1), "retention.same_character_d1": rate(1, 2, 1),
      "retention.same_character_d7": rate(1, 2, 1), "retention.same_character_w1": rate(1, 2, 1),
      "conversion.paid_d7": rate(1, 2, 1), "conversion.paid_d30": rate(0, 0, 3),
    },
  },
  {
    key: "thirty-day-cohort-maturity", dataset: cohort, asOf: at("2026-07-02T00:00:00Z"),
    expected: {
      "conversion.paid_d30": rate(2, 2, 1), "conversion.paid_d7": rate(1, 3, 0),
      "activation.chat_24h": rate(3, 3, 0), "activation.relationship_7d": rate(2, 3, 0),
      "activation.generation_7d": rate(1, 3, 0), "retention.same_character_d1": rate(1, 3, 0),
      "retention.same_character_d7": rate(1, 3, 0), "retention.same_character_w1": rate(1, 3, 0),
    },
  },
  {
    key: "utc-week-sustained-gap-distinct-exchange-and-future-exclusions", dataset: weekly, asOf: at("2026-07-19T23:59:59Z"),
    expected: {
      "north_star.wpcu": count(2, 4), "north_star.wscu": count(1, 2), "diagnostic.wsr": count(1, 2),
      "guardrail.wscru": count(1, 1), "business.wpscu": count(1, 1),
      "retention.same_character_d1": rate(2, 2, 0), "retention.same_character_d7": rate(0, 0, 2),
      "retention.same_character_w1": rate(0, 0, 2),
    },
  },
  {
    key: "signup-cutoff-inclusive-and-pre-signup-excluded", asOf: at("2026-07-02T00:00:00Z"),
    dataset: {
      signups: ["cutoff", "outside"].map((userId) => ({ userId, occurredAt: at("2026-06-01T10:00:00Z"), eligible: true })),
      chatExchanges: [...episode("cutoff", "a", "2026-06-02T09:59:56Z"), ...episode("outside", "a", "2026-05-31T20:00:00Z")],
      generationDeliveries: [
        { requestId: "at-cutoff", userId: "cutoff", occurredAt: at("2026-06-08T10:00:00Z"), eligible: true },
        { requestId: "after-cutoff", userId: "outside", occurredAt: at("2026-06-08T10:00:00.001Z"), eligible: true },
      ],
      subscriptions: [
        { subscriptionId: "at-cutoff", userId: "cutoff", activeAt: at("2026-07-01T10:00:00Z"), endedAt: null, eligible: true },
        { subscriptionId: "before-signup", userId: "outside", activeAt: at("2026-05-31T00:00:00Z"), endedAt: null, eligible: true },
      ],
    },
    expected: { "activation.chat_24h": rate(1, 2, 0), "activation.generation_7d": rate(1, 2, 0), "conversion.paid_d7": rate(0, 2, 0), "conversion.paid_d30": rate(1, 2, 0) },
  },
];

export function validateCanonicalMetricFormulae(evaluate = evaluateCanonicalMetrics) {
  const checks = cases.flatMap((scenario) => {
    let evaluation: CanonicalMetricEvaluation | null = null;
    let error: string | null = null;
    try { evaluation = evaluate(scenario.dataset, scenario.asOf); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    return Object.entries(scenario.expected).map(([metricKey, expected]) => {
      const result = evaluation?.metrics[metricKey];
      const actual = result ? {
        numerator: result.numerator, denominator: result.denominator, value: result.value,
        matureSampleSize: result.matureSampleSize, immatureSampleSize: result.immatureSampleSize,
      } : null;
      return { scenario: scenario.key, metricKey, expected, actual, error, passed: error === null && canonicalSha256(actual) === canonicalSha256(expected) };
    });
  });
  return { inputHash: canonicalSha256(cases), evidenceHash: canonicalSha256(checks), checks };
}

// Re-evaluated by each deployed process; persisted evidence cannot survive a changed answer.
export const METRIC_FORMULA_VALIDATION = validateCanonicalMetricFormulae();
