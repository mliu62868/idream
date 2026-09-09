import type { MetricDashboardResponse } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
import { materializeMetricSnapshots } from "./query";

export const METRIC_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;

export function summarizeMetricRefresh(dashboard: MetricDashboardResponse) {
  const blocked = dashboard.cards.filter((card) => card.decisionUse === "blocked");
  const official = dashboard.cards.filter((card) => card.publicationStatus === "official");
  return {
    asOf: dashboard.asOf,
    quality: dashboard.quality,
    snapshots: dashboard.cards.length,
    decisionReady: dashboard.quality.qualityState === "certified"
      && official.length > 0 && official.every((card) => card.decisionUse === "allowed"),
    blockedMetrics: blocked.map((card) => ({
      key: card.key,
      publicationStatus: card.publicationStatus,
      qualityState: card.qualityState,
      reasons: card.qualityEvidence,
    })),
    metrics: dashboard.cards.map((card) => ({
      key: card.key,
      definitionVersion: card.definitionVersion,
      publicationStatus: card.publicationStatus,
      qualityState: card.qualityState,
      decisionUse: card.decisionUse,
      value: card.value,
      sampleSize: card.sampleSize,
      matureSampleSize: card.matureSampleSize,
      immatureSampleSize: card.immatureSampleSize,
      maturity: card.maturity,
      latestDataAt: card.latestDataAt,
    })),
  };
}

/** One non-overlapping background loop in Main's existing event consumer. */
export function startMetricSnapshotRefresh(): { close(): Promise<void> } {
  let inFlight: Promise<void> | null = null;
  const refresh = () => {
    if (inFlight) return;
    inFlight = materializeMetricSnapshots(prisma)
      .then((dashboard) => {
        const report = summarizeMetricRefresh(dashboard);
        logger.info({
          asOf: report.asOf,
          snapshots: report.snapshots,
          decisionReady: report.decisionReady,
          qualityState: report.quality.qualityState,
          blockedMetrics: report.blockedMetrics.map((metric) => metric.key),
        }, "metric snapshots refreshed");
      })
      .catch((err) => logger.error({ err }, "metric snapshot refresh failed"))
      .finally(() => { inFlight = null; });
  };
  const timer = setInterval(refresh, METRIC_REFRESH_INTERVAL_MS);
  refresh();
  return {
    async close() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
