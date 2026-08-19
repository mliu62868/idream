import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { todayOperationalText } from "./format";
import { TodayView, type TodayData, type TodayLegacyData } from "./TodayView";
import { groupTodayQueueItems } from "./WorkQueue";

const legacy: TodayLegacyData = {
  metrics: {
    users: { active: 9, suspended: 1 },
    generation: { queued: 2, failed: 3, blocked: 1, successRate: 75 },
    moderation: { openReports: 5 },
    billing: { activeSubscriptions: 4 },
  },
  featureFlags: [],
};

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const daysAhead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

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
  slaDueAt: daysAgo(21),
  recommendedAction: "Review and advance the case",
  openedAt: daysAgo(30),
  deepLink: "/admin/cases/case-1",
  verificationState: "pending" as const,
  lastChangedAt: daysAgo(4),
  environment: "test" as const,
  dataClass: "customer" as const,
  pinned: false,
  preferenceVersion: 0,
  claim: null,
};

const emptyQueue = { totalCount: 0, items: [] };

function data(overrides: Partial<TodayData["projection"]> = {}): TodayData {
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

function render(projection: Partial<TodayData["projection"]> = {}, workMode: "support" | "creative_operator" | "growth_analyst" = "support") {
  return renderToStaticMarkup(createElement(TodayView, { data: data(projection), workMode }));
}

describe("Today authoritative projection", () => {
  it("localizes structured operational copy without translating record titles or identifiers", () => {
    expect(todayOperationalText("generation · reviewing", "zh")).toBe("生成 · 审核中");
    expect(todayOperationalText("customer user-1 is waiting", "zh")).toBe("客户 user-1 · 等待中");
    expect(todayOperationalText("feed_item character:item-1 is new", "zh")).toBe("内容项 角色:item-1 · 新建");
    expect(todayOperationalText("Incident is detected", "zh")).toBe("事故 · 已发现");
    expect(todayOperationalText("Operator-authored title", "zh")).toBe("Operator-authored title");
  });

  it("renders exact totals, owner, and concrete deep links", () => {
    const html = render();

    expect(html).toContain("data-testid=\"today-view\"");
    expect(html).not.toContain("today-ranking-v1");
    expect(html).toContain("href=\"/admin/cases/case-1\"");
    expect(html).toContain("Showing 1 of 12");
    expect(html).toContain("aria-selected:bg-[var(--ad-ink)]");
    expect(html).not.toContain("Unavailable");
    expect(html).not.toContain("Degraded Today projection");
  });

  it("reports the queue state instead of a fixed all-clear banner", () => {
    const html = render();
    const banner = html.slice(html.indexOf("Queue health"), html.indexOf("today-kpis"));

    // 队列里躺着一条超期三周的工作，横幅不许再说"已是最新"。
    expect(html).not.toContain("Today&#x27;s queue is up to date");
    expect(banner).toContain("items are past their SLA");
    expect(banner).toContain("var(--ad-red-bg)");
    expect(banner).not.toContain("var(--ad-green-bg)");
    // 数据新鲜度保留，但只是新鲜度，不冒充队列健康。
    expect(banner).toContain("Fresh as of");
    // 排在最前的那条直接给出去，省掉"往下滚动找第一件事"。
    expect(banner).toContain("Start here");
    expect(banner).toContain("support request case");
  });

  it("stays calm only when nothing is overdue and nothing is unowned", () => {
    const upcoming = { ...item, slaDueAt: daysAhead(9) };
    const banner = render({
      myShift: { totalCount: 1, items: [upcoming] },
      nextBestActions: { totalCount: 1, items: [upcoming] },
    });

    expect(banner).toContain("Nothing overdue.");
    expect(banner).toContain("var(--ad-green-bg)");
    expect(banner).not.toContain("items are past their SLA");
  });

  it("warns when work is waiting for an owner and says so on an empty shift", () => {
    const claimable = { ...item, ownerId: null, slaDueAt: null, claim: { entityVersion: 4 } };
    const html = render({
      myShift: emptyQueue,
      nextBestActions: { totalCount: 3, items: [claimable] },
      unassigned: { totalCount: 3, items: [claimable] },
    });

    expect(html).toContain("items have no owner");
    expect(html).toContain("var(--ad-yellow-bg)");
    expect(html).toContain("Your shift is empty while 3 items have no owner. Claim one to start.");
    expect(html).toContain("Review unclaimed work");
  });

  it("exposes the five counts and marks the overdue count as a floor until the authority answers", () => {
    const html = render({ unassigned: { totalCount: 3, items: [] }, recentlyResolved: { totalCount: 7, items: [] } });
    const kpis = html.slice(html.indexOf("today-kpis"), html.indexOf("role=\"tablist\""));

    expect(kpis).toContain("Open work");
    expect(kpis).toContain(">12<");
    expect(kpis).toContain("SLA overdue");
    // 每个队列只发前十条 —— 精确计数到达前，写成下限而不是假装精确。
    expect(kpis).toContain("≥1");
    expect(kpis).toContain("Unclaimed");
    expect(kpis).toContain("Resolved in 24h");
    expect(kpis).toContain(">7<");
  });

  it("encodes severity and SLA urgency instead of rendering every item in the same grey", () => {
    const critical = { ...item, sourceId: "case-2", severity: "critical" as const, title: "critical case" };
    const low = { ...item, sourceId: "case-3", severity: "low" as const, slaDueAt: null, title: "low case" };
    const html = render({ myShift: { totalCount: 2, items: [critical, low] }, nextBestActions: emptyQueue });
    const shift = html.slice(html.indexOf("today-queue-my-shift"), html.indexOf("today-queue-next-best-actions"));

    expect(shift).toContain("var(--ad-red-bg)");
    expect(shift).toContain("bg-black/[0.05]");
    // 超时说超了多久，不留一串要读者自己做减法的时间戳。
    expect(shift).toContain("SLA due");
    expect(shift).not.toContain(critical.slaDueAt);
  });

  it("defaults to one scannable row per item and only offers actions on live work", () => {
    const html = render({ recentlyResolved: { totalCount: 1, items: [{ ...item, sourceId: "case-9" }] } });
    const shift = html.slice(html.indexOf("today-queue-my-shift"), html.indexOf("today-queue-next-best-actions"));
    const resolved = html.slice(html.indexOf("today-queue-recently-resolved"));

    expect(shift).toContain("aria-label=\"Select support request case\"");
    expect(shift).toContain("customer user-1 is waiting");
    // recommendedAction 是舒适视图才展开的第二层，紧凑列表里不占一行。
    expect(shift).not.toContain("Review and advance the case");
    expect(shift).not.toContain("test · customer");
    expect(resolved).not.toContain("type=\"checkbox\"");
    expect(resolved).not.toContain("More actions");
  });

  it("surfaces verification only once it has an outcome", () => {
    const html = render({ myShift: { totalCount: 1, items: [{ ...item, verificationState: "failed" as const }] } });

    expect(html).not.toContain("Verification: pending");
    expect(html).toContain("SLA due");
  });

  it("uses a truthful empty state for zero-count queues", () => {
    const html = render({ myShift: emptyQueue, nextBestActions: emptyQueue }, "growth_analyst");

    expect(html).toContain("No matching work right now.");
    expect(html).toContain("Nothing is waiting for you right now.");
    expect(html).not.toContain("Legacy source unavailable");
  });

  it("offers a direct Claim action only when the server returns a claim version", () => {
    const claimable = { ...item, ownerId: null, claim: { entityVersion: 4 } };
    const html = render({ unassigned: { totalCount: 1, items: [claimable] } });

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

    const html = render({
      myShift: emptyQueue,
      nextBestActions: { totalCount: rankedItems.length, items: rankedItems },
    }, "creative_operator");
    expect(html).toContain("2 related Creative Runs");
    expect(html).toContain("Review 1 more");
    expect(html.match(/today-related-creative-runs/g)).toHaveLength(1);
    expect(html.indexOf("Creative run-1")).toBeLessThan(html.indexOf("support request case"));
    expect(html.indexOf("support request case")).toBeLessThan(html.indexOf("Creative run-3"));
  });
});
