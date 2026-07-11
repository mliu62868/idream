import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayView, type TodayData, type TodayLegacyData } from "./TodayView";

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
  it("renders exact totals, owner, SLA, verification, freshness, and concrete deep links", () => {
    const html = renderToStaticMarkup(createElement(TodayView, { data: data(), workMode: "support" }));

    expect(html).toContain("data-testid=\"today-view\"");
    expect(html).toContain("Authoritative Today projection");
    expect(html).toContain("Ranking policy: today-ranking-v1");
    expect(html).toContain("Owner: support-1");
    expect(html).toContain("Verification: pending");
    expect(html).toContain("href=\"/admin/cases/case-1\"");
    expect(html).toContain("Showing 1 of 12 authoritative items");
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
});
