import { describe, expect, it } from "vitest";
import { parseTodayUrl, todayAllWorkPath, todayBrowserPath } from "./query";

describe("Today All Work URL state", () => {
  it("round-trips filters and the stable cursor through shareable browser and authority URLs", () => {
    const state = parseTodayUrl(new URLSearchParams("todayTab=all&domain=admin_case&severity=high&sla=overdue&owner=mine&status=waiting&environment=test&cursor=opaque"));

    expect(todayBrowserPath(state)).toBe("/admin/today?todayTab=all&domain=admin_case&severity=high&sla=overdue&owner=mine&status=waiting&environment=test&cursor=opaque");
    expect(todayAllWorkPath(state, "support")).toBe("/api/v2/admin/today/all-work?workMode=support&limit=25&domain=admin_case&severity=high&sla=overdue&owner=mine&status=waiting&environment=test&cursor=opaque");
  });
});
