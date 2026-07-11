import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayView, type TodayLegacyData } from "./TodayView";

const legacyData: TodayLegacyData = {
  metrics: {
    users: { active: 9, suspended: 1 },
    generation: { queued: 2, failed: 3, blocked: 1, successRate: 75 },
    moderation: { openReports: 5 },
    billing: { activeSubscriptions: 4 },
  },
  featureFlags: [],
};
const allPermissions = new Set(["generation.job.read", "safety.review.read", "support.request.read"]);

describe("Today legacy fallback", () => {
  it("exposes degraded provenance and refuses to invent owner/SLA/verification queues", () => {
    const html = renderToStaticMarkup(createElement(TodayView, {
      data: legacyData,
      permissions: allPermissions,
      workMode: "admin",
    }));

    expect(html).toContain("data-testid=\"today-view\"");
    expect(html).toContain("Degraded Today projection");
    expect(html).toContain("Owner, SLA, impact, ranking confidence, and verification are unavailable");
    expect(html).toContain("My shift");
    expect(html).toContain("Unassigned work");
    expect(html).toContain("Watching");
    expect(html).toContain("Recently resolved");
  });

  it("uses work mode to prioritize signals without changing their values", () => {
    const html = renderToStaticMarkup(createElement(TodayView, {
      data: legacyData,
      permissions: allPermissions,
      workMode: "support",
    }));

    expect(html.indexOf("Active support cases")).toBeLessThan(html.indexOf("Failed or blocked jobs"));
    expect(html).toContain(">4<");
  });
});
