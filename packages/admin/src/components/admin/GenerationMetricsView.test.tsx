import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GenerationMetricsView,
  metricsSnapshotForWindow,
  metricsWindowErrorMessage,
  previousWindowTotals,
  ratio,
  windowTotals,
  type MetricsResponse,
  type WindowTotals,
} from "./GenerationMetricsView";
import { translateAdmin } from "./i18n";

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

function totals(overrides: Partial<WindowTotals> = {}): WindowTotals {
  return { total: 0, failed: 0, blocked: 0, cost: 0, impressions: 0, clicks: 0, ...overrides };
}

describe("GenerationMetricsView authority states", () => {
  it("does not render zero-valued business metrics before authority data loads", () => {
    const html = renderToStaticMarkup(<GenerationMetricsView />);

    expect(html).toContain("Loading generation metrics");
    expect(html).not.toContain("No generation records in window.");
    expect(html).not.toContain(">Remix<");
  });

  it("never serves a 7-day snapshot under the 30-day query key", () => {
    const snapshots = { 7: metrics(7) };

    expect(metricsSnapshotForWindow(snapshots, 7)).toEqual(metrics(7));
    expect(metricsSnapshotForWindow(snapshots, 30)).toBeNull();
  });

  it("names the real last-good window when the requested window is unavailable", () => {
    const message = metricsWindowErrorMessage({
      error: "Request failed.",
      requestedWindowDays: 30,
      hasRequestedSnapshot: false,
      lastGoodWindowDays: 7,
    });

    expect(translateAdmin("en", message.key, message.values)).toBe(
      "Request failed. 30-day metrics are unavailable. The last successful snapshot was 7 days and is not shown for this window.",
    );
  });

  // SPEC: 窗口错误文案在中文 locale 下不能整句露英文——它是 key + 插值，不是拼好的成品句。
  it("translates the window error instead of emitting a built English sentence", () => {
    const message = metricsWindowErrorMessage({
      error: "boom",
      requestedWindowDays: 7,
      hasRequestedSnapshot: true,
      lastGoodWindowDays: 7,
    });

    const zh = translateAdmin("zh", message.key, message.values);
    expect(zh).toContain("boom");
    expect(zh).not.toContain("Showing the last successfully loaded");
  });
});

describe("GenerationMetricsView decision arithmetic", () => {
  it("totals jobs from sources, which is the only bucket that keeps null-keyed rows", () => {
    const snapshot: MetricsResponse = {
      ...metrics(7),
      // profiles/recipes 丢掉了 null 外键的行；sources 没有，所以合计只能走 sources。
      profiles: [{ profileId: "p", profileVersion: 1, label: null, workflowKey: null, total: 4, completed: 3, failed: 1, blocked: 0, costDreamcoins: 40, avgDurationMs: null }],
      sources: [
        { sourceType: "chat", total: 10, completed: 7, failed: 3, blocked: 0, costDreamcoins: 100 },
        { sourceType: "studio", total: 6, completed: 6, failed: 0, blocked: 1, costDreamcoins: 60 },
      ],
      placementEngagement: [
        { slot: "feed_card", placementId: "a", impressions: 200, clicks: 10 },
        { slot: "homepage_strip", placementId: "b", impressions: 300, clicks: 5 },
      ],
    };

    expect(windowTotals(snapshot)).toEqual({
      total: 16,
      failed: 3,
      blocked: 1,
      cost: 160,
      impressions: 500,
      clicks: 15,
    });
  });

  it("computes CTR from impressions and clicks and leaves an empty denominator unmeasured", () => {
    expect(ratio(15, 500)).toBe(0.03);
    expect(ratio(0, 0)).toBeNull();
  });

  it("derives the previous window by subtracting the current one from the doubled window", () => {
    const previous = previousWindowTotals(
      totals({ total: 10, failed: 2, cost: 100, impressions: 500, clicks: 15 }),
      totals({ total: 25, failed: 9, cost: 260, impressions: 900, clicks: 20 }),
    );

    expect(previous).toEqual(totals({ total: 15, failed: 7, cost: 160, impressions: 400, clicks: 5 }));
  });

  it("reports no comparison rather than a fabricated one when the windows disagree", () => {
    expect(
      previousWindowTotals(totals({ total: 10 }), totals({ total: 8 })),
    ).toBeNull();
  });
});
