import { describe, expect, it } from "vitest";
import { activeTodayFilters, parseTodayUrl, todayAllWorkPath, todayBrowserPath, todayStatusGroups, withoutTodayFilters } from "./query";

describe("Today All Work URL state", () => {
  it("round-trips filters and the stable cursor through shareable browser and authority URLs", () => {
    const state = parseTodayUrl(new URLSearchParams("todayTab=all&domain=admin_case&severity=high&sla=overdue&owner=mine&status=waiting&environment=test&cursor=opaque"));

    expect(todayBrowserPath(state)).toBe("/admin/today?todayTab=all&domain=admin_case&severity=high&sla=overdue&owner=mine&status=waiting&environment=test&cursor=opaque");
    expect(todayAllWorkPath(state, "support")).toBe("/api/v2/admin/today/all-work?workMode=support&limit=25&domain=admin_case&severity=high&sla=overdue&owner=mine&status=waiting&environment=test&cursor=opaque");
  });

  it("narrows status options to the selected domain and groups them otherwise", () => {
    expect(todayStatusGroups("creative_run")).toEqual([{ domain: "creative_run", statuses: ["active"] }]);

    const grouped = todayStatusGroups();
    expect(grouped).toHaveLength(6);
    // 一个扁平 select 里混六个领域的状态，选中的组合注定查不到东西。
    expect(grouped.find((group) => group.domain === "ops_incident")?.statuses).toContain("mitigating");
    expect(grouped.find((group) => group.domain === "creative_run")?.statuses).not.toContain("mitigating");
    expect(grouped.flatMap((group) => group.statuses)).toContain("reopened");
  });

  it("lists the filters in force and clears them without leaving the tab", () => {
    const state = parseTodayUrl(new URLSearchParams("todayTab=all&severity=critical&owner=unassigned&cursor=opaque"));

    expect(activeTodayFilters(state)).toEqual([
      { key: "severity", value: "critical" },
      { key: "owner", value: "unassigned" },
    ]);
    expect(withoutTodayFilters(state)).toEqual({ tab: "all", limit: 25 });
  });
});
