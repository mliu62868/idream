import { describe, expect, it } from "vitest";
import {
  evaluateCanonicalMetrics,
  type CanonicalMetricDataset,
  type MetricChatExchange,
} from "./engine";

const hour = 60 * 60 * 1000;

function exchanges(input: {
  userId: string;
  characterId: string;
  sessionId: string;
  at: string;
  count: number;
  eligible?: boolean;
}): MetricChatExchange[] {
  return Array.from({ length: input.count }, (_, index) => ({
    exchangeId: `${input.userId}:${input.characterId}:${input.sessionId}:${index}`,
    userId: input.userId,
    characterId: input.characterId,
    engagementSessionId: input.sessionId,
    occurredAt: new Date(new Date(input.at).getTime() + index * 1_000),
    eligible: input.eligible ?? true,
  }));
}

function dataset(overrides: Partial<CanonicalMetricDataset> = {}): CanonicalMetricDataset {
  return {
    signups: [],
    chatExchanges: [],
    generationDeliveries: [],
    subscriptions: [],
    ...overrides,
  };
}

describe("canonical metric engine", () => {
  it("counts QCE v1 only after five distinct eligible exchanges in one UTC day and engagement session", () => {
    const result = evaluateCanonicalMetrics(dataset({
      chatExchanges: [
        ...exchanges({ userId: "four", characterId: "c1", sessionId: "s1", at: "2026-07-01T10:00:00Z", count: 4 }),
        ...exchanges({ userId: "five", characterId: "c1", sessionId: "s2", at: "2026-07-01T11:00:00Z", count: 5 }),
        ...exchanges({ userId: "corrected", characterId: "c1", sessionId: "s3", at: "2026-07-01T12:00:00Z", count: 5 }).map((row, index) => index === 4 ? { ...row, eligible: false } : row),
      ],
    }), new Date("2026-07-20T00:00:00Z"));

    expect(result.qualifiedEpisodes.map((episode) => episode.userId)).toEqual(["five"]);
    expect(result.depthMilestones).toEqual({ firstSuccessfulExchange: 3, fiveExchange: 1, twentyExchange: 0 });
  });

  it("uses mature signup cohorts and exact UTC product days for activation, D1, D7, W1, and paid conversion", () => {
    const chatExchanges = [
      ...exchanges({ userId: "u1", characterId: "c1", sessionId: "u1-d0", at: "2026-06-01T08:00:00Z", count: 5 }),
      ...exchanges({ userId: "u1", characterId: "c1", sessionId: "u1-d1", at: "2026-06-02T08:01:00Z", count: 5 }),
      ...exchanges({ userId: "u1", characterId: "c1", sessionId: "u1-d7", at: "2026-06-08T09:00:00Z", count: 5 }),
      ...exchanges({ userId: "u2", characterId: "c2", sessionId: "u2-d0", at: "2026-06-01T10:00:00Z", count: 5 }),
      ...exchanges({ userId: "u2", characterId: "c2", sessionId: "u2-d2", at: "2026-06-03T10:00:00Z", count: 5 }),
      ...exchanges({ userId: "recent", characterId: "c3", sessionId: "recent-d0", at: "2026-06-16T01:00:00Z", count: 5 }),
    ];
    const result = evaluateCanonicalMetrics(dataset({
      signups: [
        { userId: "u1", occurredAt: new Date("2026-06-01T00:00:00Z"), eligible: true },
        { userId: "u2", occurredAt: new Date("2026-06-01T00:00:00Z"), eligible: true },
        { userId: "recent", occurredAt: new Date("2026-06-16T00:00:00Z"), eligible: true },
        { userId: "internal", occurredAt: new Date("2026-06-01T00:00:00Z"), eligible: false },
      ],
      chatExchanges,
      generationDeliveries: [
        { requestId: "g-u2", userId: "u2", occurredAt: new Date("2026-06-04T00:00:00Z"), eligible: true },
      ],
      subscriptions: [
        { subscriptionId: "sub-u1", userId: "u1", activeAt: new Date("2026-06-05T00:00:00Z"), endedAt: null, eligible: true },
        { subscriptionId: "sub-u2", userId: "u2", activeAt: new Date("2026-06-11T00:00:00Z"), endedAt: null, eligible: true },
      ],
    }), new Date("2026-06-16T12:00:00Z"));

    expect(result.metrics["activation.chat_24h"]).toMatchObject({ numerator: 2, denominator: 2, value: 1, matureSampleSize: 2 });
    expect(result.metrics["activation.relationship_7d"]).toMatchObject({ numerator: 2, denominator: 2, value: 1, matureSampleSize: 2 });
    expect(result.metrics["activation.generation_7d"]).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, matureSampleSize: 2 });
    expect(result.metrics["retention.same_character_d1"]).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, immatureSampleSize: 1 });
    expect(result.metrics["retention.same_character_d7"]).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, immatureSampleSize: 1 });
    expect(result.metrics["retention.same_character_w1"]).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, immatureSampleSize: 1 });
    expect(result.metrics["conversion.paid_d7"]).toMatchObject({ numerator: 1, denominator: 2, value: 0.5, matureSampleSize: 2 });
    expect(result.metrics["conversion.paid_d30"]).toMatchObject({ numerator: 0, denominator: 0, value: null, immatureSampleSize: 3 });
  });

  it("deduplicates D0, requires the same character on exact D1, ignores D2 for D1, and leaves D7 immature", () => {
    const result = evaluateCanonicalMetrics(dataset({
      chatExchanges: [
        ...exchanges({ userId: "exact", characterId: "c1", sessionId: "d0-a", at: "2026-07-01T08:00:00Z", count: 5 }),
        ...exchanges({ userId: "exact", characterId: "c1", sessionId: "d0-duplicate", at: "2026-07-01T18:00:00Z", count: 5 }),
        ...exchanges({ userId: "exact", characterId: "c1", sessionId: "d1", at: "2026-07-02T00:01:00Z", count: 5 }),
        ...exchanges({ userId: "wrong-character", characterId: "c1", sessionId: "d0", at: "2026-07-01T08:00:00Z", count: 5 }),
        ...exchanges({ userId: "wrong-character", characterId: "c2", sessionId: "d1-other", at: "2026-07-02T08:00:00Z", count: 5 }),
        ...exchanges({ userId: "d2-only", characterId: "c1", sessionId: "d0", at: "2026-07-01T08:00:00Z", count: 5 }),
        ...exchanges({ userId: "d2-only", characterId: "c1", sessionId: "d2", at: "2026-07-03T08:00:00Z", count: 5 }),
        ...exchanges({ userId: "immature", characterId: "c1", sessionId: "d0", at: "2026-07-04T08:00:00Z", count: 5 }),
      ],
    }), new Date("2026-07-05T12:00:00Z"));

    expect(result.metrics["retention.same_character_d1"]).toMatchObject({
      numerator: 1,
      denominator: 4,
      value: 0.25,
      immatureSampleSize: 1,
    });
    expect(result.metrics["retention.same_character_d7"]).toMatchObject({
      denominator: 0,
      value: null,
      immatureSampleSize: 5,
      maturity: "immature",
    });
  });

  it("keeps WPCU official while evaluating sustained companion and creation candidates as shadow", () => {
    const windowStart = new Date("2026-07-13T00:00:00Z");
    const result = evaluateCanonicalMetrics(dataset({
      chatExchanges: [
        ...exchanges({ userId: "companion", characterId: "c1", sessionId: "a", at: "2026-07-14T08:00:00Z", count: 5 }),
        ...exchanges({ userId: "companion", characterId: "c1", sessionId: "b", at: "2026-07-15T08:01:00Z", count: 5 }),
        ...exchanges({ userId: "too-close", characterId: "c2", sessionId: "a", at: "2026-07-14T23:00:00Z", count: 5 }),
        ...exchanges({ userId: "too-close", characterId: "c2", sessionId: "b", at: "2026-07-15T01:00:00Z", count: 5 }),
      ],
      generationDeliveries: [
        { requestId: "g1", userId: "creator", occurredAt: new Date("2026-07-14T01:00:00Z"), eligible: true },
        { requestId: "g2", userId: "creator", occurredAt: new Date("2026-07-15T14:00:00Z"), eligible: true },
      ],
      subscriptions: [
        { subscriptionId: "paid-companion", userId: "companion", activeAt: windowStart, endedAt: null, eligible: true },
        { subscriptionId: "paid-creator", userId: "creator", activeAt: windowStart, endedAt: null, eligible: true },
      ],
    }), new Date("2026-07-19T23:59:59Z"));

    expect(result.metrics["north_star.wpcu"]).toMatchObject({
      numerator: 2,
      publicationStatus: "official",
      definitionVersion: 2,
      window: "current_utc_calendar_week",
    });
    expect(result.metrics["north_star.wscu"]).toMatchObject({ numerator: 1, publicationStatus: "shadow" });
    expect(result.metrics["diagnostic.wsr"]).toMatchObject({ numerator: 1, publicationStatus: "diagnostic" });
    expect(result.metrics["guardrail.wscru"]).toMatchObject({ numerator: 1, publicationStatus: "shadow" });
    expect(result.metrics["business.wpscu"]).toMatchObject({ numerator: 1, publicationStatus: "shadow" });
    expect(result.metrics["north_star.wscu"].window).toBe("rolling_7d_utc");
    expect(result.metrics["north_star.wscu"].definitionVersion).toBe(1);
    expect(result.metrics["north_star.wscu"].asOf.toISOString()).toBe("2026-07-19T23:59:59.000Z");
    expect(result.metrics["north_star.wscu"].sampleSize).toBeGreaterThan(0);
    expect(result.metrics["north_star.wscu"].qualityState).toBe("directional");
    expect(result.metrics["north_star.wscu"].value).toBe(1);
  });

  it("uses the UTC Monday calendar-week boundary for the official WPCU", () => {
    const result = evaluateCanonicalMetrics(dataset({
      chatExchanges: [
        ...exchanges({ userId: "previous-week", characterId: "c1", sessionId: "old", at: "2026-07-12T23:59:00Z", count: 1 }),
        ...exchanges({ userId: "current-week", characterId: "c1", sessionId: "new", at: "2026-07-13T00:01:00Z", count: 1 }),
      ],
      subscriptions: [
        { subscriptionId: "paid-old", userId: "previous-week", activeAt: new Date("2026-07-01T00:00:00Z"), endedAt: null, eligible: true },
        { subscriptionId: "paid-new", userId: "current-week", activeAt: new Date("2026-07-01T00:00:00Z"), endedAt: null, eligible: true },
      ],
    }), new Date("2026-07-15T12:00:00Z"));

    expect(result.metrics["north_star.wpcu"]).toMatchObject({
      numerator: 1,
      sampleSize: 1,
      window: "current_utc_calendar_week",
    });
  });

  it("does not count a subscription outside the user's signup cohort as D7 or D30 conversion", () => {
    const result = evaluateCanonicalMetrics(dataset({
      signups: [{ userId: "old-user", occurredAt: new Date("2026-01-01T00:00:00Z"), eligible: true }],
      subscriptions: [{
        subscriptionId: "late-sub",
        userId: "old-user",
        activeAt: new Date("2026-02-15T00:00:00Z"),
        endedAt: null,
        eligible: true,
      }],
    }), new Date("2026-03-01T00:00:00Z"));

    expect(result.metrics["conversion.paid_d7"]).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(result.metrics["conversion.paid_d30"]).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
    expect(new Date("2026-02-15T00:00:00Z").getTime() - new Date("2026-01-01T00:00:00Z").getTime()).toBeGreaterThan(30 * 24 * hour);
  });
});
