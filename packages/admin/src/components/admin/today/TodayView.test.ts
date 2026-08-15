import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { groupTodayQueueItems, todayOperationalText, TodayView, type TodayData, type TodayLegacyData } from "./TodayView";

const legacy: TodayLegacyData = {
  metrics: {
    users: { active: 9, suspended: 1 },
    generation: { queued: 2, failed: 3, blocked: 1, successRate: 75 },
    moderation: { openReports: 5 },
    billing: { activeSubscriptions: 4 },
  },
  featureFlags: [],
};
const item = {
  sourceType: "admin_case" as const,
  sourceId: "case-1",
  sourceStatus: "waiting" as const,
  title: "support request case",
  summary: "customer user-1 is waiting",
  severity: "high" as const,
  priority: "high" as const,
  impactSnapshot: { targetId: "user-1" },
  ownerId: "support-1",
  slaDueAt: "2026-07-11T14:00:00.000Z",
  recommendedAction: "Review and advance the case",
  rankingReason: "high severity · SLA 2026-07-11T14:00:00.000Z",
  deepLink: "/admin/cases/case-1",
  verificationState: "pending" as const,
  lastChangedAt: "2026-07-11T12:00:00.000Z",
  environment: "test" as const,
  dataClass: "customer" as const,
  pinned: false,
  preferenceVersion: 0,
  claim: null,
};

function data(overrides: Partial<TodayData["projection"]> = {}): TodayData {
  const emptyQueue = { totalCount: 0, items: [] };
  return {
    legacy,
    projection: {
      myShift: { totalCount: 1, items: [item] },
      nextBestActions: { totalCount: 12, items: [item] },
      unassigned: emptyQueue,
      watching: emptyQueue,
      recentlyResolved: emptyQueue,
      asOf: "2026-07-11T12:00:00.000Z",
      freshness: "fresh",
      workMode: "support",
      rankingPolicyVersion: "today-ranking-v1",
      ...overrides,
    },
  };
}

describe("Today authoritative projection", () => {
  it("localizes structured operational copy without translating record titles or identifiers", () => {
    expect(todayOperationalText("generation · reviewing", "zh")).toBe("生成 · 审核中");
    expect(todayOperationalText("customer user-1 is waiting", "zh")).toBe("客户 user-1 · 等待中");
    expect(todayOperationalText("feed_item character:item-1 is new", "zh")).toBe("内容项 角色:item-1 · 新建");
    expect(todayOperationalText("Incident is detected", "zh")).toBe("事故 · 已发现");
    expect(todayOperationalText("high severity · SLA 2026-07-11T14:00:00.000Z · open since 2026-07-11T12:00:00.000Z", "zh"))
      .toBe("严重程度：高 · SLA：2026年7月11日 14:00 · 开始于 2026年7月11日 12:00");
    expect(todayOperationalText("medium severity · open since 2026-07-20T12:16:55.757Z", "zh"))
      .toBe("严重程度：中 · 开始于 2026年7月20日 12:16");
    expect(todayOperationalText("Operator-authored title", "zh")).toBe("Operator-authored title");
  });

  it("renders exact totals, owner, SLA, verification, freshness, and concrete deep links", () => {
    const html = renderToStaticMarkup(createElement(TodayView, { data: data(), workMode: "support" }));

    expect(html).toContain("data-testid=\"today-view\"");
    expect(html).toContain("Authoritative Today projection");
    expect(html).toContain("Ranking policy: today-ranking-v1");
    expect(html).toContain("Owner: support-1");
    expect(html).toContain("Verification: pending");
    expect(html).toContain("href=\"/admin/cases/case-1\"");
    expect(html).toContain("Showing 1 of 12 authoritative items");
    expect(html).toContain("aria-selected:bg-[var(--ad-ink)]");
    expect(html).not.toContain("Unavailable");
    expect(html).not.toContain("Degraded Today projection");
  });

  it("uses a truthful empty state for zero-count queues", () => {
    const emptyQueue = { totalCount: 0, items: [] };
    const html = renderToStaticMarkup(createElement(TodayView, {
      data: data({ myShift: emptyQueue, nextBestActions: emptyQueue }),
      workMode: "growth_analyst",
    }));

    expect(html).toContain("No matching work right now.");
    expect(html).not.toContain("Legacy source unavailable");
  });

  it("offers a direct Claim action only when the server returns a claim version", () => {
    const claimable = { ...item, ownerId: null, claim: { entityVersion: 4 } };
    const html = renderToStaticMarkup(createElement(TodayView, {
      data: data({ unassigned: { totalCount: 1, items: [claimable] } }),
      workMode: "support",
    }));

    expect(html).toContain(">Claim</button>");
    expect(html).toContain("bg-[var(--ad-ink)]");
    expect(html).not.toContain("Open to claim");
  });

  it("collapses only adjacent Creative Runs for the same target and purpose without changing rank order", () => {
    const creative = (sourceId: string, targetId: string) => ({
      ...item,
      sourceType: "creative_run" as const,
      sourceId,
      sourceStatus: "active" as const,
      title: `Creative ${sourceId}`,
      impactSnapshot: {
        purpose: "visual_identity_calibration",
        targetType: "character",
        targetId,
      },
      deepLink: `/admin/creative/runs/${sourceId}`,
    });
    const rankedItems = [
      creative("run-1", "alexa-reeves"),
      creative("run-2", "alexa-reeves"),
      item,
      creative("run-3", "alexa-reeves"),
    ];

    const groups = groupTodayQueueItems(rankedItems);
    expect(groups.map((group) => group.items.map(({ sourceId }) => sourceId))).toEqual([
      ["run-1", "run-2"],
      ["case-1"],
      ["run-3"],
    ]);
    expect(new Set(groups.map(({ key }) => key)).size).toBe(groups.length);

    const html = renderToStaticMarkup(createElement(TodayView, {
      data: data({
        myShift: { totalCount: 0, items: [] },
        nextBestActions: { totalCount: rankedItems.length, items: rankedItems },
      }),
      workMode: "creative_operator",
    }));
    expect(html).toContain("2 related Creative Runs");
    expect(html).toContain("Review 1 more");
    expect(html.match(/today-related-creative-runs/g)).toHaveLength(1);
    expect(html.indexOf("Creative run-1")).toBeLessThan(html.indexOf("support request case"));
    expect(html.indexOf("support request case")).toBeLessThan(html.indexOf("Creative run-3"));
  });
});
