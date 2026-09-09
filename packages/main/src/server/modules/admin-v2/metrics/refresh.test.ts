import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricCard, MetricDashboardResponse } from "@idream/shared/admin";
import { logger } from "@/server/lib/logger";
import { materializeMetricSnapshots } from "./query";
import { METRIC_REFRESH_INTERVAL_MS, startMetricSnapshotRefresh, summarizeMetricRefresh } from "./refresh";

vi.mock("@/server/lib/db", () => ({ prisma: {} }));
vi.mock("@/server/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("./query", () => ({ materializeMetricSnapshots: vi.fn() }));

function dashboard(cards: readonly MetricCard[] = []): MetricDashboardResponse {
  return {
    asOf: "2026-09-06T12:00:00.000Z", definitions: [], cards, freshness: "fresh",
    quality: {
      asOf: "2026-09-06T12:00:00.000Z", qualityState: "certified", incompleteOutcomeCount: 0,
      duplicateEffectCount: 0, impossibleStateCount: 0, fixtureInternalLeakageCount: 0,
      joinCoverage: 1, userJoinCoverage: 1, characterJoinCoverage: 1,
      contentVersionJoinCoverage: 1, releaseJoinCoverage: 1, eventLagP95Ms: 1_000,
      freshnessSloMs: 3_600_000, scannedFactCount: 1, checks: [],
    },
  };
}

function officialCard(): MetricCard {
  return {
    key: "north_star.wpcu", definitionVersion: 2, publicationStatus: "official", name: "WPCU",
    value: null, unit: "users", numeratorLabel: "users", denominatorLabel: "none",
    numeratorValue: 1, denominatorValue: null, sampleSize: 1, matureSampleSize: 1, immatureSampleSize: 0,
    window: "current UTC calendar week", timezone: "UTC", maturity: "mature",
    asOf: "2026-09-06T12:00:00.000Z", validFrom: "2026-07-11T00:00:00.000Z",
    latestDataAt: "2026-09-06T11:59:00.000Z", qualityState: "invalid", decisionUse: "blocked",
    qualityEvidence: ["definition_not_certified", "definition_validation_evidence_missing"],
  };
}

describe("metric refresh lifecycle", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("does not overlap a slow refresh and drains it before shutdown", async () => {
    vi.useFakeTimers();
    let finish: ((value: MetricDashboardResponse) => void) | undefined;
    vi.mocked(materializeMetricSnapshots).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const loop = startMetricSnapshotRefresh();
    expect(materializeMetricSnapshots).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(METRIC_REFRESH_INTERVAL_MS * 2);
    expect(materializeMetricSnapshots).toHaveBeenCalledTimes(1);
    const closed = vi.fn();
    const closing = loop.close().then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    finish?.(dashboard());
    await closing;
    expect(closed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(METRIC_REFRESH_INTERVAL_MS);
    expect(materializeMetricSnapshots).toHaveBeenCalledTimes(1);
  });

  it("reports a failed run and retries on the next interval", async () => {
    vi.useFakeTimers();
    const failure = new Error("database unavailable");
    vi.mocked(materializeMetricSnapshots).mockRejectedValueOnce(failure).mockResolvedValue(dashboard());
    const loop = startMetricSnapshotRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith({ err: failure }, "metric snapshot refresh failed");
    await vi.advanceTimersByTimeAsync(METRIC_REFRESH_INTERVAL_MS);
    expect(materializeMetricSnapshots).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ snapshots: 0, decisionReady: false }), "metric snapshots refreshed");
    await loop.close();
  });

  it("keeps the CLI decision gate blocked when live facts pass but the official definition has no validation", () => {
    const report = summarizeMetricRefresh(dashboard([officialCard()]));
    expect(report.quality.qualityState).toBe("certified");
    expect(report.decisionReady).toBe(false);
    expect(report.blockedMetrics).toEqual([{
      key: "north_star.wpcu", publicationStatus: "official", qualityState: "invalid",
      reasons: ["definition_not_certified", "definition_validation_evidence_missing"],
    }]);
    expect(report.metrics[0]).toMatchObject({ matureSampleSize: 1, immatureSampleSize: 0, value: null });
    expect(summarizeMetricRefresh(dashboard([{ ...officialCard(), value: 1, qualityState: "certified", decisionUse: "allowed", qualityEvidence: ["verified"] }])).decisionReady).toBe(true);
  });
});
