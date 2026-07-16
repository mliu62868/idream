import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GenerationMetricsView,
  metricsSnapshotForWindow,
  metricsWindowErrorMessage,
  type MetricsResponse,
} from "./GenerationMetricsView";

function metrics(windowDays: 7 | 30): MetricsResponse {
  return {
    windowDays,
    profiles: [],
    recipes: [],
    sources: [],
    placements: [],
    placementEngagement: [],
    remix: { total: 0 },
  };
}

describe("GenerationMetricsView authority states", () => {
  it("does not render zero-valued business metrics before authority data loads", () => {
    const html = renderToStaticMarkup(<GenerationMetricsView />);

    expect(html).toContain("Loading authoritative generation metrics");
    expect(html).not.toContain("No generation records in window.");
    expect(html).not.toContain(">Remix<");
  });

  it("never serves a 7-day snapshot under the 30-day query key", () => {
    const snapshots = { 7: metrics(7) };

    expect(metricsSnapshotForWindow(snapshots, 7)).toEqual(metrics(7));
    expect(metricsSnapshotForWindow(snapshots, 30)).toBeNull();
  });

  it("names the real last-good window when the requested window is unavailable", () => {
    expect(
      metricsWindowErrorMessage({
        error: "Request failed.",
        requestedWindowDays: 30,
        hasRequestedSnapshot: false,
        lastGoodWindowDays: 7,
      }),
    ).toBe(
      "Request failed. 30-day metrics are unavailable. The last successful snapshot was 7 days and is not shown for this window.",
    );
  });
});
